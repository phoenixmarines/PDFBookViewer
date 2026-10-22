# 📖 PDF Book Viewer

A dependency-free HTML app that opens a PDF and shows it as an open book with a
real page-turn animation — from a local file **or** from a file hosted anywhere
on the web — and mints a shareable link so other people can open the same hosted
file straight in their browser.

## Run it

```bash
# any static server works — or just double-click index.html
python -m http.server 8080
# → http://localhost:8080
```

Nothing to build. `index.html` + `styles.css` + `app.js`, rendering by
[pdf.js](https://mozilla.github.io/pdf.js/) from a CDN.

## Features

| | |
|---|---|
| **Open a local file** | `Open file…` button or drag & drop a PDF anywhere on the page |
| **Open a hosted file** | paste a URL in the top bar → `Open URL` (also auto-loads from `?src=`); a plain relative path like `book.pdf` resolves next to `index.html` |
| **Share links** | `Share` copies `…/?src=<pdf-url>&page=3&layout=spread`; whoever opens it gets the same file at the same page |
| **Page turn** | CSS 3D leaf hinged on the spine: click an edge arrow, press `←`/`→`, click a page, or **drag a page** past ~90° to commit / back to cancel |
| **Two-page spread ↔ single page** | `Two-page / Single` button (auto-picks single on narrow screens) |
| **Zoom** | `−` / `+` / `Fit` buttons, keys `-` `+` `0` |
| **Page jump** | type a page number in the footer field |

### Keyboard

`→` `Space` `PageDown` next · `←` `PageUp` previous · `Home`/`End` first/last ·
`+` `-` `0` zoom · `L` toggle layout

## Sharing: how it works and what it needs

`Share` builds a link containing the **URL of the hosted PDF**, e.g.

```
https://you.example/viewer/?src=https%3A%2F%2Fraw.githubusercontent.com%2Fuser%2Frepo%2Fmain%2Fbook.pdf&page=3&layout=spread
```

Opening that link re-fetches the same file, so the recipient sees the same book
at the same page. A few ground rules:

- **Local files can't be shared** — a `blob:` URL only exists in your browser.
  Upload the PDF somewhere public first, open it here by URL, then press `Share`.
- **The viewer itself must be reachable** too. If you double-clicked
  `index.html` (`file://`), the copied link only resolves on your machine —
  host the three files (GitHub Pages, Netlify, your own server…) and share the
  hosted copy of the app.
- The link is a plain query string, so it survives email, chat, QR codes, etc.

## Where to host the PDF — same server, or anywhere?

**Anywhere is fine; the PDF does *not* have to sit on the same server as
`index.html`/`app.js`.** A browser only needs the *host* to opt in with an
`Access-Control-Allow-Origin` header. Two ways to go:

1. **Different host (PDF on GitHub, app somewhere else)** — works as long as
   the PDF's host sends the header. Verified `Access-Control-Allow-Origin: *`:

   | Host | How you get a URL |
   |---|---|
   | `raw.githubusercontent.com/user/repo/main/book.pdf` | drag the file into a **public** GitHub repo → *Download raw file* |
   | `cdn.jsdelivr.net/gh/user/repo@main/book.pdf` | same repo, CDN-cached, good for large files |
   | GitHub Pages (`*.github.io`) | header is host-wide — verified, even on 404s |
   | `unpkg.com`, `raw.githack.com` | |
   | `arxiv.org/pdf/…`, `rfc-editor.org` | public papers/specs open directly |

2. **Same host (PDF next to the app)** — same-origin, so CORS never enters the
   picture and no host configuration is needed. Put `book.pdf` beside
   `index.html` and type `book.pdf` (or `/path/book.pdf`) in the URL box — it is
   resolved against wherever the viewer is served from. This is the bulletproof
   option: one folder → upload → share.

Not verified / usually blocked: Google Drive, Dropbox, random websites — use
the ⚙ CORS-proxy fallback or move the file to one of the hosts above.

## CORS: which URLs open directly

Browsers only let a page read a cross-origin file if the host allows it
(`Access-Control-Allow-Origin`). The app tries the URL **directly first**:

| Host | Direct? |
|---|---|
| `raw.githubusercontent.com/...` | ✅ sends `ACAO: *` |
| `cdn.jsdelivr.net/...` (incl. `gh/user/repo/file`) | ✅ |
| GitHub Pages / S3 / most CDNs / your own server | ✅ if configured |
| `github.com/.../blob/...` | 🔄 auto-rewritten to `raw.githubusercontent.com/...` for you |
| `drive.google.com`, random websites, `w3.org` samples | ❌ |

If the direct fetch fails and **⚙ → “Fallback through a CORS proxy”** is
enabled, the app retries once through the proxy template (default
`https://api.codetabs.com/v1/proxy?quest={url}`, editable and remembered in
`localStorage`). Public proxies are free and rate-limited — for anything
important, host the PDF on a CORS-friendly host instead.

## How the page turn works

- Pages are laid out as spreads: `[null, 1]`, `[2, 3]`, `[4, 5]` …
  (odd page on the right, even on the left; the last page may sit alone).
- Turning forward paints the *underlying* spread as `left = old left`,
  `right = new right`, then a `.flipper` leaf — front face = the old right page,
  back face = the new left page — rotates `0° → -180°` around the spine
  (`transform-origin: left center`), exactly like lifting a sheet and laying it
  down on the left.
- Turning back runs the same leaf from `-180° → 0°`.
- Dragging maps pointer distance to the rotation angle: release past 90°
  completes the turn, release before 90° springs back.
- Single-page mode swaps the leaf for a slide-out (`.leaf` translates off to the
  left, the next page already sitting underneath).

Rendered pages are cached (6 entries, capped at 2400 px and 2× DPR) so turns are
instant; zooming re-renders only the visible pages.

## Files

```
index.html   markup + pdf.js CDN tag
styles.css   theme, book geometry, 3D flip
app.js       loading, spreads, rendering, animation, sharing
```