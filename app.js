/* global pdfjsLib */
/**
 * PDF Book Viewer — single-page app.
 * Opens PDFs from disk or from a hosted URL, shows them as a book with a
 * page-turn animation, and mints shareable links for hosted files.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const ASSET_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';

  const RENDER_DPR_CAP = 2;      // don't render at crazy device pixel ratios
  const RENDER_MAX_DIM = 2400;   // max canvas edge in pixels
  const CACHE_LIMIT = 6;         // cached rendered pages (memory bound)
  const FLIP_MS = 620;           // page-turn duration

  if (!window.pdfjsLib) {
    document.getElementById('toast').className = 'toast show error';
    document.getElementById('toast').textContent =
      'The PDF engine (pdf.js) could not be loaded — check your internet connection, or vendor pdf.min.js + pdf.worker.min.js next to this file.';
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + 'pdf.worker.min.js';

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), book: $('book'), pageLeft: $('pageLeft'), pageRight: $('pageRight'),
    flipper: $('flipper'), faceFront: $('faceFront'), faceBack: $('faceBack'), gutter: $('gutter'),
    empty: $('emptyState'), edgePrev: $('edgePrev'), edgeNext: $('edgeNext'), dropVeil: $('dropVeil'),
    fileInput: $('fileInput'), urlInput: $('urlInput'), openUrlBtn: $('openUrlBtn'),
    shareBtn: $('shareBtn'), proxyEnabled: $('proxyEnabled'), proxyTemplate: $('proxyTemplate'),
    indicator: $('indicator'), pageInput: $('pageInput'), pageTotal: $('pageTotal'), meta: $('meta'),
    firstBtn: $('firstBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), lastBtn: $('lastBtn'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'), layoutBtn: $('layoutBtn'),
    toast: $('toast'),
  };

  const state = {
    pdf: null,
    numPages: 0,
    aspect: 0.7071,          // width / height of page 1 (fallback: A4)
    spreads: [],             // [[leftPage|null, rightPage|null], ...]
    idx: 0,
    layout: 'spread',
    zoom: 1,
    base: { w: 0, h: 0 },
    source: null,            // { type:'file'|'url', name, url? }
    cache: new Map(),        // "page|W|H" -> Promise<canvas>
    animating: false,
    live: null,              // in-progress drag flip
    token: 0,                // document generation counter
  };

  // ---------------------------------------------------------------- utils
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let toastTimer = 0;
  function toast(msg, kind = '') {
    el.toast.textContent = msg;
    el.toast.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.className = 'toast ' + kind; }, 4200);
  }

  function waitTransition(node, maxMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        node.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== node || e.propertyName !== 'transform') return;
        finish();
      };
      const timer = setTimeout(finish, maxMs);
      node.addEventListener('transitionend', onEnd);
    });
  }

  // ---------------------------------------------------------------- layout
  function computeBase() {
    const r = el.stage.getBoundingClientRect();
    const availW = Math.max(120, r.width - 40);
    const availH = Math.max(120, r.height - 40);
    const cols = state.layout === 'spread' ? 2 : 1;
    let w = availW / cols;
    let h = w / state.aspect;
    if (h > availH) { h = availH; w = h * state.aspect; }
    state.base = { w, h };
  }

  const pageSize = () => ({ w: state.base.w * state.zoom, h: state.base.h * state.zoom });

  function applySize() {
    if (!state.pdf) return;
    computeBase();
    const { w, h } = pageSize();
    const spread = state.layout === 'spread';
    el.book.classList.toggle('single', !spread);
    el.book.style.width = (spread ? w * 2 : w) + 'px';
    el.book.style.height = h + 'px';
    el.pageLeft.style.width = w + 'px';
    el.pageLeft.style.height = h + 'px';
    el.pageRight.style.width = w + 'px';
    el.pageRight.style.height = h + 'px';
    el.flipper.style.left = (spread ? w : 0) + 'px';
    el.flipper.style.width = w + 'px';
    el.flipper.style.height = h + 'px';
    el.gutter.style.left = w + 'px';
    paintSpread();
  }

  function buildSpreads(n) {
    const out = [];
    if (state.layout === 'single') {
      for (let i = 1; i <= n; i++) out.push([null, i]);
      return out;
    }
    if (n >= 1) out.push([null, 1]);
    let p = 2;
    while (p <= n) {
      out.push([p, p + 1 <= n ? p + 1 : null]);
      p += 2;
    }
    return out;
  }

  function spreadIndexOf(page) {
    if (state.layout === 'single') return clamp(page - 1, 0, state.spreads.length - 1);
    for (let i = 0; i < state.spreads.length; i++) {
      const [l, r] = state.spreads[i];
      if (l === page || r === page) return i;
    }
    return 0;
  }

  const currentPage = () => {
    const s = state.spreads[state.idx];
    return (s && (s[0] || s[1])) || 1;
  };

  // ---------------------------------------------------------------- rendering
  function renderMaster(num, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, RENDER_DPR_CAP);
    const W = Math.min(Math.round(w * dpr), RENDER_MAX_DIM);
    const H = Math.min(Math.round(h * dpr), RENDER_MAX_DIM);
    const key = num + '|' + W + '|' + H;

    if (state.cache.has(key)) {
      const p = state.cache.get(key);
      state.cache.delete(key);
      state.cache.set(key, p); // refresh LRU position
      return p;
    }

    const promise = state.pdf.getPage(num).then((page) => {
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min(W / vp0.width, H / vp0.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(() => canvas);
    }).catch((err) => {
      state.cache.delete(key);
      console.warn('Render failed for page', num, err);
      return null;
    });

    state.cache.set(key, promise);
    if (state.cache.size > CACHE_LIMIT) {
      const oldest = state.cache.keys().next().value;
      if (oldest !== key) state.cache.delete(oldest);
    }
    return promise;
  }

  /** Draw a copy of a master canvas into a container, contained in (w,h) CSS px. */
  function placeInto(dest, master, w, h) {
    const c = document.createElement('canvas');
    c.width = master.width;
    c.height = master.height;
    c.getContext('2d').drawImage(master, 0, 0);
    const a = c.width / c.height;
    let cw = w, ch = cw / a;
    if (ch > h) { ch = h; cw = ch * a; }
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    dest.appendChild(c);
  }

  function paintSlot(slot, num) {
    slot.innerHTML = '';
    slot.classList.toggle('empty-page', !num);
    if (!num || !state.pdf) return;
    const { w, h } = pageSize();
    const mySlot = (slot._tok = (slot._tok || 0) + 1);
    renderMaster(num, w, h).then((master) => {
      if (!master || slot._tok !== mySlot) return; // superseded by a newer paint/zoom
      placeInto(slot, master, w, h);
    });
  }

  function paintSpread(underlying) {
    const s = underlying || state.spreads[state.idx] || [null, null];
    paintSlot(el.pageLeft, s[0]);
    paintSlot(el.pageRight, s[1]);
  }

  async function setFace(dest, num, w, h) {
    dest.innerHTML = '';
    dest.classList.toggle('empty-page', !num);
    if (!num || !state.pdf) return;
    const master = await renderMaster(num, w, h);
    if (master) placeInto(dest, master, w, h);
  }

  // ---------------------------------------------------------------- page turn
  const canGo = (dir) => !!state.pdf && (dir === 'next'
    ? state.idx < state.spreads.length - 1
    : state.idx > 0);

  async function prepareFlip(dir) {
    const targetIdx = state.idx + (dir === 'next' ? 1 : -1);
    const cur = state.spreads[state.idx];
    const tgt = state.spreads[targetIdx];
    const { w, h } = pageSize();
    const needed = (dir === 'next' ? [cur[1], tgt[0]] : [tgt[1], cur[0]]).filter(Boolean);
    await Promise.all(needed.map((n) => renderMaster(n, w, h)));
    return { targetIdx, cur, tgt, w, h };
  }

  /** Paint the underlying spread + both leaf faces, leaf parked at its start angle. */
  async function setupFlip(dir, ctx) {
    const { cur, tgt, w, h } = ctx;
    if (dir === 'next') {
      // left keeps the old page, right is revealed underneath the lifting leaf
      paintSpread([cur[0], tgt[1]]);
      await Promise.all([setFace(el.faceFront, cur[1], w, h), setFace(el.faceBack, tgt[0], w, h)]);
      el.flipper.style.transform = 'rotateY(0deg)';
    } else {
      paintSpread(tgt);
      await Promise.all([setFace(el.faceFront, tgt[1], w, h), setFace(el.faceBack, cur[0], w, h)]);
      el.flipper.style.transform = 'rotateY(-180deg)';
    }
    el.flipper.style.transition = 'none';
    el.flipper.hidden = false;
    void el.flipper.offsetWidth;
  }

  function clearFlip() {
    el.flipper.hidden = true;
    el.flipper.style.transition = 'none';
    el.flipper.style.transform = 'rotateY(0deg)';
    el.faceFront.innerHTML = '';
    el.faceBack.innerHTML = '';
  }

  function commitFlip(targetIdx) {
    clearFlip();
    state.idx = targetIdx;
    state.animating = false;
    state.live = null;
    paintSpread();
    updateUI();
  }

  function rollbackFlip() {
    clearFlip();
    state.animating = false;
    state.live = null;
    paintSpread();
    updateUI();
  }

  /** Single-page mode: the current page slides away, the next one sits beneath. */
  async function slideSingle(dir, ctx, animate) {
    const { tgt, w, h } = ctx;
    const num = ctx.cur[1];
    const master = num ? await renderMaster(num, w, h) : null;
    if (!master) { commitFlip(ctx.targetIdx); return; }

    const leaf = document.createElement('div');
    leaf.className = 'leaf';
    leaf.style.width = w + 'px';
    leaf.style.height = h + 'px';
    placeInto(leaf, master, w, h);
    el.book.appendChild(leaf);   // cover the slot first…
    paintSpread(tgt);            // …then swap what is underneath
    void leaf.offsetWidth;

    if (!animate) { leaf.remove(); commitFlip(ctx.targetIdx); return; }

    const out = dir === 'next' ? -100 : 100;
    const tilt = dir === 'next' ? -16 : 16;
    leaf.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.32,.06,.24,1)`;
    leaf.style.transform = `translateX(${out}%) rotateY(${tilt}deg)`;
    await waitTransition(leaf, FLIP_MS + 150);
    leaf.remove();
    commitFlip(ctx.targetIdx);
  }

  async function go(dir, animate = true) {
    if (state.animating || !canGo(dir)) return false;
    state.animating = true;
    try {
      const ctx = await prepareFlip(dir);
      if (state.layout === 'single') return await slideSingle(dir, ctx, animate);
      await setupFlip(dir, ctx);
      if (!animate) { commitFlip(ctx.targetIdx); return true; }
      el.flipper.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.32,.06,.24,1)`;
      el.flipper.style.transform = dir === 'next' ? 'rotateY(-180deg)' : 'rotateY(0deg)';
      await waitTransition(el.flipper, FLIP_MS + 150);
      commitFlip(ctx.targetIdx);
      return true;
    } catch (err) {
      console.error(err);
      rollbackFlip();
      return false;
    }
  }

  // ---------------------------------------------------------------- drag turn
  let drag = null;

  function liveTransform(dir, angle) {
    return dir === 'next' ? `rotateY(${-angle}deg)` : `rotateY(${-(180 - angle)}deg)`;
  }

  function applyLive(dx, w) {
    const d = state.live;
    d.angle = d.dir === 'next'
      ? clamp((-dx / w) * 180, 0, 180)
      : clamp((dx / w) * 180, 0, 180);
    el.flipper.style.transition = 'none';
    el.flipper.style.transform = liveTransform(d.dir, d.angle);
  }

  function endLive() {
    const d = state.live;
    const ctx = d.ctx;
    const commit = d.angle >= 90;
    const travelled = commit ? 180 - d.angle : d.angle;
    const dur = clamp((FLIP_MS * Math.max(travelled, 12)) / 180, 140, FLIP_MS);
    el.flipper.style.transition = `transform ${dur}ms cubic-bezier(.3,.07,.2,1)`;
    el.flipper.style.transform = commit
      ? liveTransform(d.dir, 180)
      : liveTransform(d.dir, 0);
    waitTransition(el.flipper, dur + 150).then(() => {
      if (commit) commitFlip(ctx.targetIdx);
      else rollbackFlip();
    });
  }

  function onPointerDown(e) {
    if (!state.pdf || state.animating || e.button !== 0) return;
    if (e.target.closest('button')) return;
    drag = { x0: e.clientX, y0: e.clientY, dir: null, ctx: null, ready: false, dx: 0, pid: e.pointerId };
    try { el.book.setPointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
  }

  /** Prepare + paint the leaf for a drag that just started. */
  async function startLive(dir) {
    try {
      const ctx = await prepareFlip(dir);
      if (!drag || drag.dir !== dir) { state.animating = false; return; } // released too early
      await setupFlip(dir, ctx);
      if (!drag || drag.dir !== dir) { rollbackFlip(); return; }
      drag.ctx = ctx;
      drag.ready = true;
      state.live = { dir, ctx, angle: dir === 'next' ? 0 : 180 };
      applyLive(drag.dx, pageSize().w);
    } catch (err) {
      console.error(err);
      if (state.live || state.animating) rollbackFlip();
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    drag.dx = dx;

    if (!drag.dir) {
      if (Math.abs(dx) < 8) return;                            // below drag threshold
      if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // vertical scroll
      const dir = dx < 0 ? 'next' : 'prev';
      if (state.layout !== 'spread') { drag = null; return; } // live drag only in spread mode
      if (state.animating || !canGo(dir)) { drag = null; return; }
      drag.dir = dir;
      state.animating = true;
      startLive(dir);
      return;
    }

    if (drag.ready) applyLive(drag.dx, pageSize().w);
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null; // startLive() notices the release and rolls back if it was still preparing
    try { el.book.releasePointerCapture?.(d.pid); } catch (_) { /* ignore */ }

    if (!d.dir) {
      // a plain click turns the page (right half → next, left half → previous)
      const rect = el.book.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (e.clientX > mid) go('next');
      else if (e.clientX < mid) go('prev');
      return;
    }
    if (d.ready && state.live) endLive();
  }

  // ---------------------------------------------------------------- document
  function proxyTemplate() {
    return (el.proxyTemplate.value || '').trim() || 'https://api.codetabs.com/v1/proxy?quest={url}';
  }

  function proxied(url) {
    const t = proxyTemplate();
    return t.includes('{url}') ? t.replace('{url}', encodeURIComponent(url)) : t + encodeURIComponent(url);
  }

  async function fetchBytes(url) {
    const attempts = [{ label: 'direct', target: url }];
    if (el.proxyEnabled.checked) attempts.push({ label: 'CORS proxy', target: proxied(url) });

    let lastErr = null;
    for (const a of attempts) {
      try {
        const res = await fetch(a.target, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 128) throw new Error('empty response');
        if (a.label !== 'direct') toast('Opened through the CORS proxy (' + a.label + ').', 'ok');
        return buf;
      } catch (err) {
        lastErr = err;
        console.warn('fetch failed (' + a.label + '):', err.message);
      }
    }
    throw lastErr || new Error('fetch failed');
  }

  async function openDoc(data, source, opts = {}) {
    const token = ++state.token;
    el.meta.textContent = 'Loading ' + (source.name || 'document') + '…';
    try {
      const task = pdfjsLib.getDocument({
        data,
        cMapUrl: ASSET_CDN + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: ASSET_CDN + 'standard_fonts/',
        isEvalSupported: false,
      });
      const pdf = await task.promise;
      if (token !== state.token) return;

      state.pdf = pdf;
      state.numPages = pdf.numPages;
      state.source = source;
      state.cache.clear();

      const p1 = await pdf.getPage(1);
      const vp1 = p1.getViewport({ scale: 1 });
      state.aspect = vp1.width / vp1.height;

      state.layout = opts.layout || (window.innerWidth < 780 ? 'single' : 'spread');
      state.spreads = buildSpreads(state.numPages);
      state.zoom = 1;
      state.idx = opts.page ? spreadIndexOf(opts.page) : 0;

      clearFlip();
      state.animating = false;
      el.empty.hidden = true;
      el.book.hidden = false;
      applySize();
      updateUI();

      const where = source.type === 'url' ? source.url : source.name;
      el.meta.textContent = `${source.name} · ${state.numPages} page${state.numPages === 1 ? '' : 's'}`;
      toast('Opened ' + where, 'ok');
    } catch (err) {
      console.error(err);
      if (token !== state.token) return;
      el.meta.textContent = state.pdf ? el.meta.textContent : 'No document loaded';
      const msg = /invalid|corrupt|format/i.test(err.message || '')
        ? 'That file could not be parsed as a PDF (' + (err.message || err.name) + ').'
        : 'Could not open the PDF: ' + (err.message || err);
      toast(msg, 'error');
    }
  }

  async function openFile(file) {
    if (!file) return;
    if (!/pdf/i.test(file.type || '') && !/\.pdf$/i.test(file.name || '')) {
      toast('That does not look like a PDF file.', 'error');
      return;
    }
    toast('Reading ' + file.name + '…');
    try {
      const buf = await file.arrayBuffer();
      await openDoc(buf, { type: 'file', name: file.name });
    } catch (err) {
      console.error(err);
      toast('Could not read the file: ' + err.message, 'error');
    }
  }

  /** GitHub blob/raw links are not CORS-enabled; their raw.githubusercontent.com twin is. */
  function normalizeUrl(url) {
    let m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/raw\/(.+)$/i);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    m = url.match(/^https?:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/(.+)$/i);
    if (m && /[?&]raw(=true)?(&|$)/i.test(url)) return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}`.replace(/\?.*$/, '');
    return url;
  }

  async function openUrl(raw, opts = {}) {
    let url = (raw || '').trim();
    if (!url) { toast('Paste a PDF URL first.', 'error'); return; }
    if (/^\/\//.test(url)) {
      url = location.protocol + url;
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      // No scheme: a bare domain → assume https; anything else → a path relative
      // to where this viewer is hosted (so a PDF shipped next to index.html just works).
      const first = url.split(/[/?#]/)[0];
      const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(first)
        && !/\.(pdf|html?|txt|md|json|zip|epub)$/i.test(first);
      url = looksLikeHost ? 'https://' + url : new URL(url, location.href).href;
    }
    const asTyped = url;
    url = normalizeUrl(url);
    const converted = url !== asTyped;
    el.urlInput.value = url;

    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'document.pdf';
    toast((converted ? 'GitHub link rewritten to its raw download URL. ' : '') + 'Fetching ' + name + '…');
    try {
      const buf = await fetchBytes(url);
      await openDoc(buf, { type: 'url', name, url }, opts);
    } catch (err) {
      console.error(err);
      toast('Could not fetch that URL (' + (err.message || err) + '). ' +
        'The host likely blocks cross-origin reads (CORS) — try a host such as ' +
        'raw.githubusercontent.com, cdn.jsdelivr.net, or your own server, or enable the CORS proxy in ⚙.', 'error');
      el.meta.textContent = 'No document loaded';
    }
  }

  // ---------------------------------------------------------------- share link
  function buildShareUrl() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    const p = new URLSearchParams();
    p.set('src', state.source.url);
    p.set('layout', state.layout);
    const page = currentPage();
    if (page > 1) p.set('page', String(page));
    u.search = p.toString();
    return u.toString();
  }

  async function share() {
    if (!state.source || state.source.type !== 'url') {
      toast('Only web-hosted PDFs can be shared. Upload the file somewhere ' +
        '(e.g. GitHub, your own server, a CDN), open it by URL here, then press Share.', 'error');
      return;
    }
    const link = buildShareUrl();
    try {
      await navigator.clipboard.writeText(link);
      if (location.protocol === 'file:') {
        toast('Link copied — but this viewer is running from a local file, so the link only resolves on ' +
          'your machine. Host the viewer itself (GitHub Pages, Netlify, any web server) so other people can open it.', 'error');
      } else {
        toast('Share link copied — anyone who opens it sees this file at page ' + currentPage() + '.', 'ok');
      }
    } catch (_) {
      window.prompt('Copy this share link:', link);
    }
  }

  // ---------------------------------------------------------------- UI
  function updateUI() {
    const has = !!state.pdf;
    const n = state.spreads.length;
    const s = state.spreads[state.idx] || [null, null];
    const pages = s.filter(Boolean);

    if (!has) {
      el.indicator.textContent = '—';
      el.pageTotal.textContent = '/ 0';
      el.edgePrev.hidden = el.edgeNext.hidden = true;
    } else {
      el.indicator.textContent = pages.length > 1
        ? `Pages ${pages[0]}–${pages[1]} · ${state.idx + 1}/${n}`
        : `Page ${pages[0]} · ${state.idx + 1}/${n}`;
      el.pageTotal.textContent = '/ ' + state.numPages;
      if (document.activeElement !== el.pageInput) el.pageInput.value = pages[0] || 1;
      el.edgePrev.hidden = el.edgeNext.hidden = false;
    }

    const noPrev = !has || state.idx === 0;
    const noNext = !has || state.idx >= n - 1;
    el.prevBtn.disabled = el.firstBtn.disabled = el.edgePrev.disabled = noPrev;
    el.nextBtn.disabled = el.lastBtn.disabled = el.edgeNext.disabled = noNext;
    el.shareBtn.disabled = !has;
    el.shareBtn.title = (state.source && state.source.type === 'url')
      ? 'Copy a link that opens this hosted PDF for someone else'
      : 'Sharing needs a web-hosted PDF — upload the file somewhere, open it here by URL, then click Share';
    el.zoomIn.disabled = el.zoomOut.disabled = !has;
    el.layoutBtn.disabled = !has;
    el.layoutBtn.textContent = state.layout === 'spread' ? 'Two-page' : 'Single';
    el.layoutBtn.title = state.layout === 'spread' ? 'Switch to single page' : 'Switch to two-page spread';
  }

  function toggleLayout() {
    if (!state.pdf || state.animating) return;
    const page = currentPage();
    state.layout = state.layout === 'spread' ? 'single' : 'spread';
    state.spreads = buildSpreads(state.numPages);
    state.idx = spreadIndexOf(page);
    applySize();
    updateUI();
  }

  function setZoom(z) {
    if (!state.pdf) return;
    state.zoom = clamp(z, 0.4, 4);
    applySize();
  }

  function gotoPage(page) {
    if (!state.pdf || state.animating) return;
    const idx = spreadIndexOf(clamp(page, 1, state.numPages));
    if (idx === state.idx) return;
    state.idx = idx;
    clearFlip();
    applySize();
    updateUI();
  }

  // ---------------------------------------------------------------- events
  el.fileInput.addEventListener('change', (e) => {
    openFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  el.openUrlBtn.addEventListener('click', () => openUrl(el.urlInput.value));
  el.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openUrl(el.urlInput.value); });
  el.shareBtn.addEventListener('click', share);

  el.proxyEnabled.addEventListener('change', () => {
    try { localStorage.setItem('pdfbook.proxy', el.proxyEnabled.checked ? '1' : '0'); } catch (_) {}
  });
  el.proxyTemplate.addEventListener('change', () => {
    try { localStorage.setItem('pdfbook.proxyTemplate', proxyTemplate()); } catch (_) {}
    el.proxyTemplate.value = proxyTemplate();
  });

  el.prevBtn.addEventListener('click', () => go('prev'));
  el.nextBtn.addEventListener('click', () => go('next'));
  el.edgePrev.addEventListener('click', () => go('prev'));
  el.edgeNext.addEventListener('click', () => go('next'));
  el.firstBtn.addEventListener('click', () => gotoPage(1));
  el.lastBtn.addEventListener('click', () => gotoPage(state.numPages));

  el.pageInput.addEventListener('change', () => gotoPage(parseInt(el.pageInput.value, 10) || 1));
  el.pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { gotoPage(parseInt(el.pageInput.value, 10) || 1); el.pageInput.blur(); }
  });

  el.zoomIn.addEventListener('click', () => setZoom(state.zoom * 1.2));
  el.zoomOut.addEventListener('click', () => setZoom(state.zoom / 1.2));
  el.zoomReset.addEventListener('click', () => setZoom(1));
  el.layoutBtn.addEventListener('click', toggleLayout);

  el.book.addEventListener('pointerdown', onPointerDown);
  el.book.addEventListener('pointermove', onPointerMove);
  el.book.addEventListener('pointerup', onPointerUp);
  el.book.addEventListener('pointercancel', () => { drag = null; if (state.live) rollbackFlip(); });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!state.pdf) return;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': e.preventDefault(); go('next'); break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); go('prev'); break;
      case 'Home': e.preventDefault(); gotoPage(1); break;
      case 'End': e.preventDefault(); gotoPage(state.numPages); break;
      case '+': case '=': e.preventDefault(); setZoom(state.zoom * 1.2); break;
      case '-': case '_': e.preventDefault(); setZoom(state.zoom / 1.2); break;
      case '0': e.preventDefault(); setZoom(1); break;
      case 'l': case 'L': toggleLayout(); break;
      default: break;
    }
  });

  // drag & drop files from the OS
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    el.dropVeil.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropVeil.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropVeil.hidden = true;
    openFile(e.dataTransfer.files[0]);
  });

  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (state.pdf) applySize(); });
  });

  // ---------------------------------------------------------------- boot
  function restoreSettings() {
    try {
      const p = localStorage.getItem('pdfbook.proxy');
      if (p !== null) el.proxyEnabled.checked = p === '1';
      const t = localStorage.getItem('pdfbook.proxyTemplate');
      if (t) el.proxyTemplate.value = t;
    } catch (_) { /* storage unavailable (file:// in some browsers) */ }
  }

  function boot() {
    restoreSettings();
    const params = new URLSearchParams(location.search);
    const src = params.get('src') || params.get('url');
    const page = parseInt(params.get('page'), 10);
    const layout = params.get('layout');
    updateUI();
    if (src) {
      const opts = {};
      if (Number.isFinite(page) && page > 0) opts.page = page;
      if (layout === 'single' || layout === 'spread') opts.layout = layout;
      openUrl(src, opts);
    }
  }

  boot();
})();