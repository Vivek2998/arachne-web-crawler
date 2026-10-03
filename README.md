<div align="center">

# 🕷 Arachne

### Crawl the web. *Watch it crawl.*

A fast, polite, concurrent web crawler with a living visual. Every crawler worker is a procedurally animated spider. It walks across the page it is reading, bites each link it discovers, tears it out of the document and spins your site map in real time.

![Arachne crawling books.toscrape.com](docs/preview.gif)

</div>

---

## ✨ Highlights

### The crawler
- **Concurrent worker pool** (1–8 workers) with **per-host rate limiting**
- **robots.txt aware**, including `Crawl-delay` and the `Sitemap:` directive
- **Sitemap seeding**: reads `sitemap.xml` and sitemap indexes to find pages that nothing links to
- **URL normalisation**: strips fragments, default ports and tracking params (`utm_*`, `fbclid`, `gclid`…), sorts query strings and dedupes
- **Retries with back-off** on network errors, `429` and `503` (honours `Retry-After`)
- **Manual redirect following** with a hop limit, so every hop is safety-checked
- **SSRF protection**: refuses hosts that resolve to private, loopback or link-local addresses
- **Streaming body reads** with a 6 MB cap, plus charset detection from headers and `<meta>`
- Respects `<meta name="robots" content="nofollow">` and `rel="nofollow"`

### The audit
Every page is checked for missing or overlong titles and descriptions, missing or multiple `<h1>`, missing alt text, canonical problems, `noindex`, thin content, missing Open Graph tags, heavy HTML, plain-HTTP pages, slow responses, redirects, and 4xx/5xx responses or failed requests. It also collects JSON-LD schema types, emails and the in-link graph.

### Exports
- **JSON**: the full report
- **CSV**: one row per page, opens in Excel or Sheets
- **sitemap.xml**: ready to submit; only indexable 2xx HTML pages, canonical URLs preferred

### The visual
- **Procedural spiders**: two-bone IK legs, an alternating tetrapod gait with velocity-predicted foot placement, planted feet, spring steering with burst speed, body bob, lunging fangs and twitching pedipalps. One spider per worker, each with its own neon colour.
- **Real pages, re-rendered**: each crawled page becomes a readable "sheet" that keeps its real headings, paragraphs and inline links. Spiders hunt the actual links.
- **Link life-cycle**: queued → targeted (reticle + bite thread) → grabbed (text scramble, glyph shards) → torn out and flown along a silk thread into the live feed
- **Silk**: draglines behind every spider, plus web strands between harvested links that build up as the page is eaten
- **Page corruption**: RGB-split, slice and font-swap glitches near the spiders
- **Reactive WebGL background**: a nebula and a giant orb web that vibrates with a shockwave on every request
- **Live site map**: a force-directed graph of pages and links (grid-accelerated physics, pan, zoom, hover, click for details)
- **Adaptive pacing**: when the crawler outruns the animation, playback speeds up and shows fewer bites per page, so the show never falls behind
- Cursor-curious idle spiders, click-to-poke, scroll to take the camera, `prefers-reduced-motion` support, and a fully responsive mobile layout

<div align="center">
<img src="docs/screenshot.png" alt="Arachne desktop UI" width="72%" />
<img src="docs/mobile.png" alt="Arachne on mobile" width="22%" />
</div>

---

## 🚀 Quick start

Requires **Node.js 20+**.

```bash
git clone https://github.com/Vivek2998/arachne-web-crawler.git
cd arachne-web-crawler
npm install

# development: API on :4173, Vite dev server on :5173
npm run dev

# production
npm run build
npm start           # http://localhost:4173
```

Open the app, paste a URL and hit **Release**. Want a safe playground? Try `books.toscrape.com` or `quotes.toscrape.com`.

### Configuration

Click the **settings** icon next to the URL bar:

| Setting | Default | |
|---|---|---|
| Max pages | 150 | stops after this many fetches |
| Max depth | 4 | link hops from the start URL |
| Spiders (concurrency) | 3 | parallel workers; up to 4 are drawn |
| Delay | 120 ms | minimum gap between requests to the same host |
| Timeout | 15 s | per request |
| Respect robots.txt | on | |
| Seed from sitemap.xml | on | |
| Include subdomains | off | `blog.example.com` counts as internal |

Server environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `MAX_SESSIONS` | `6` | concurrent crawls allowed |
| `ALLOW_PRIVATE_NETWORKS` | unset | set to `1` to crawl localhost / LAN targets |

---

## 🔌 API

The UI is a client of a small HTTP API, so you can script it as well:

```http
POST /api/crawl                     { "url": "https://example.com", "options": { "maxPages": 50 } }
GET  /api/crawl/:id/events          Server-Sent Events: init, fetch, page, fail, stats, log, done
POST /api/crawl/:id/pause | resume | stop
GET  /api/crawl/:id/export.json | export.csv | export.xml
```

The event stream supports `Last-Event-ID`, so reconnecting clients replay what they missed.

---

## 🧱 Architecture

```
server/
  index.js       Express app: crawl sessions, SSE stream with replay, exports
  crawler.js     worker pool, robots.txt, sitemaps, politeness, retries, redirects
  extract.js     HTML → metadata, links, SEO audit, and a reading-view snapshot
  url-utils.js   normalisation, scope rules, SSRF guard
client/src/
  spider.ts      procedural spider: IK legs, gait, steering, rendering
  stage.ts       page sheets, camera, spider choreography, silk, flying links
  background.ts  WebGL2 nebula + orb web with crawl shockwaves
  graph.ts       force-directed live site map
  main.ts        UI wiring, feed, pages table, issues, details, settings
```

No UI framework. Rendering is hand-written Canvas 2D + WebGL2 in a single `requestAnimationFrame` loop with frame-rate-independent damping, so motion stays smooth at 60/120 Hz.

---

## 🙏 Credits

Visual concept inspired by **Slava Rybin** ([@rybinfx](https://www.instagram.com/rybinfx/)), whose animation shows web crawlers as tiny digital spiders.

## 📄 License

[MIT](LICENSE) © Vivek Kumar
