import { EventEmitter } from 'node:events';
import robotsParser from 'robots-parser';
import * as cheerio from 'cheerio';
import { normalizeUrl, sameScope, isAssetUrl, assertPublicHost } from './url-utils.js';
import { extractPage } from './extract.js';
import { SANDBOX_HOST, sandboxFetch } from './sandbox.js';

const ARCHIVE_ORIGIN = 'https://web.archive.org';
const BLOCK_STATUSES = new Set([401, 403, 406, 429, 451, 503, 520, 521, 522, 523, 524, 525, 526]);

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULTS = {
  maxPages: 150,
  maxDepth: 4,
  concurrency: 3,
  delayMs: 120,
  timeoutMs: 15_000,
  respectRobots: true,
  useSitemap: true,
  archiveFallback: true,
  includeSubdomains: false,
  userAgent: 'ArachneBot/1.0 (+https://github.com/Vivek2998/arachne-web-crawler)',
};

export function sanitizeOptions(input = {}) {
  const n = (v, lo, hi, d) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  };
  const b = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    maxPages: n(input.maxPages, 1, 5000, DEFAULTS.maxPages),
    maxDepth: n(input.maxDepth, 0, 20, DEFAULTS.maxDepth),
    concurrency: n(input.concurrency, 1, 8, DEFAULTS.concurrency),
    delayMs: n(input.delayMs, 0, 10_000, DEFAULTS.delayMs),
    timeoutMs: n(input.timeoutMs, 2000, 60_000, DEFAULTS.timeoutMs),
    respectRobots: b(input.respectRobots, DEFAULTS.respectRobots),
    useSitemap: b(input.useSitemap, DEFAULTS.useSitemap),
    archiveFallback: b(input.archiveFallback, DEFAULTS.archiveFallback),
    includeSubdomains: b(input.includeSubdomains, DEFAULTS.includeSubdomains),
    userAgent:
      typeof input.userAgent === 'string' && input.userAgent.trim() ? input.userAgent.trim().slice(0, 200) : DEFAULTS.userAgent,
  };
}

/**
 * Concurrent, polite, breadth-first crawler.
 *
 * Events: 'fetch', 'page', 'fail', 'stats', 'log', 'done'
 */
export class Crawler extends EventEmitter {
  constructor(startUrl, options) {
    super();
    this.startUrl = normalizeUrl(startUrl);
    if (!this.startUrl) throw new Error('Invalid URL');
    this.opts = sanitizeOptions(options);
    this.queue = [];
    this.seen = new Set();
    this.pages = new Map(); // url -> page record (without snapshot)
    this.inlinks = new Map(); // url -> count
    this.edges = []; // [fromId, toUrl]
    this.robots = new Map(); // origin -> parser | null
    this.hostNextAt = new Map(); // origin -> timestamp
    this.state = 'idle';
    this.nextId = 1;
    this.stats = { crawled: 0, failed: 0, bytes: 0, totalMs: 0, linksFound: 0, external: 0, assets: 0, skippedRobots: 0 };
    this.startedAt = 0;
    this.wake = null;
    this.inFlight = 0;
    this.abort = new AbortController();
    /** true once the live site refused us and we switched to the Internet Archive */
    this.archiveMode = false;
  }

  enqueue(url, depth, from) {
    if (!url || this.seen.has(url)) return false;
    if (depth > this.opts.maxDepth) return false;
    if (this.seen.size >= this.opts.maxPages * 4 + 50) return false;
    this.seen.add(url);
    this.queue.push({ url, depth, from });
    this.wake?.();
    return true;
  }

  async start() {
    this.state = 'running';
    this.startedAt = Date.now();
    this.emit('log', { level: 'info', message: `Releasing ${this.opts.concurrency} crawler${this.opts.concurrency > 1 ? 's' : ''} on ${this.startUrl}` });
    try {
      if (new URL(this.startUrl).hostname !== SANDBOX_HOST) await assertPublicHost(this.startUrl);
    } catch (e) {
      this.emit('log', { level: 'error', message: e.message });
      return this.finish('error');
    }
    this.enqueue(this.startUrl, 0, null);
    if (this.opts.useSitemap) this.seedFromSitemaps().catch(() => {});

    this.statsTimer = setInterval(() => this.emit('stats', this.snapshotStats()), 500);
    const workers = Array.from({ length: this.opts.concurrency }, (_, i) => this.worker(i));
    await Promise.all(workers);
    this.finish(this.state === 'stopped' ? 'stopped' : this.stats.crawled >= this.opts.maxPages ? 'limit' : 'complete');
  }

  finish(reason) {
    clearInterval(this.statsTimer);
    if (this.state === 'done') return;
    this.state = 'done';
    this.finishedAt = Date.now();
    this.emit('stats', this.snapshotStats());
    this.emit('done', { reason, ...this.summary() });
  }

  pause() {
    if (this.state === 'running') {
      this.state = 'paused';
      this.emit('log', { level: 'info', message: 'Paused' });
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'running';
      this.emit('log', { level: 'info', message: 'Resumed' });
      this.wake?.();
    }
  }

  stop() {
    if (this.state === 'done') return;
    this.state = 'stopped';
    this.abort.abort();
    this.wake?.();
  }

  get active() {
    return this.state === 'running' || this.state === 'paused';
  }

  async waitForWork() {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 250);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  async worker(index) {
    while (this.active) {
      if (this.state === 'paused') {
        await this.waitForWork();
        continue;
      }
      if (this.stats.crawled + this.stats.failed + this.inFlight >= this.opts.maxPages) {
        if (this.inFlight === 0) return;
        await this.waitForWork();
        continue;
      }
      const job = this.queue.shift();
      if (!job) {
        if (this.inFlight === 0) return; // nothing queued and nothing pending -> finished
        await this.waitForWork();
        continue;
      }
      this.inFlight++;
      try {
        await this.process(job, index);
      } finally {
        this.inFlight--;
        this.wake?.();
      }
    }
  }

  async politeWait(origin, crawlDelay) {
    const gap = Math.max(this.opts.delayMs, (crawlDelay ?? 0) * 1000);
    if (!gap) return;
    const now = Date.now();
    const at = Math.max(now, this.hostNextAt.get(origin) ?? 0);
    this.hostNextAt.set(origin, at + gap);
    if (at > now) await sleep(at - now);
  }

  async getRobots(origin) {
    if (this.robots.has(origin)) return this.robots.get(origin);
    const pending = (async () => {
      try {
        const res = await this.request(`${origin}/robots.txt`, { accept: 'text/plain' });
        if (!res.ok) return null;
        const body = await res.text();
        return robotsParser(`${origin}/robots.txt`, body);
      } catch {
        return null;
      }
    })();
    this.robots.set(origin, pending);
    const parser = await pending;
    this.robots.set(origin, parser);
    return parser;
  }

  async seedFromSitemaps() {
    const origin = new URL(this.startUrl).origin;
    const robots = this.opts.respectRobots ? await this.getRobots(origin) : null;
    const maps = new Set(robots?.getSitemaps?.() ?? []);
    if (!maps.size) maps.add(`${origin}/sitemap.xml`);
    let added = 0;
    const visited = new Set();
    const budget = this.opts.maxPages * 2;
    const visit = async (url, level) => {
      if (level > 2 || visited.has(url) || visited.size > 12 || added >= budget || !this.active) return;
      visited.add(url);
      try {
        const res = await this.request(url, { accept: 'application/xml,text/xml' });
        if (!res.ok) return;
        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        const nested = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
        for (const n of nested.slice(0, 6)) await visit(n, level + 1);
        $('urlset > url > loc').each((_, el) => {
          if (added >= budget) return false;
          const u = normalizeUrl($(el).text().trim());
          if (u && sameScope(u, this.startUrl, this.opts.includeSubdomains) && !isAssetUrl(u) && this.enqueue(u, 1, null)) added++;
        });
      } catch {
        /* sitemap is optional */
      }
    };
    for (const m of maps) await visit(m, 0);
    if (added) this.emit('log', { level: 'info', message: `Sitemap seeded ${added} URLs` });
  }

  /** fetch with timeout, manual redirect following and SSRF checks at every hop */
  async request(url, { accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', method = 'GET' } = {}) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (new URL(current).hostname === SANDBOX_HOST) {
        const res = await sandboxFetch(current);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          current = normalizeUrl(res.headers.get('location'), current);
          continue;
        }
        res.finalUrl = current;
        res.redirected_ = hop > 0;
        return res;
      }
      await assertPublicHost(current);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('Timed out')), this.opts.timeoutMs);
      const onStop = () => ctrl.abort(new Error('Stopped'));
      this.abort.signal.addEventListener('abort', onStop, { once: true });
      let res;
      try {
        res = await fetch(current, {
          method,
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'user-agent': this.opts.userAgent, accept, 'accept-language': 'en;q=0.9,*;q=0.5' },
        });
      } finally {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', onStop);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        // Wayback redirects embed a full URL in the path; keep it intact
        const next = current.startsWith(ARCHIVE_ORIGIN) ? new URL(loc, current).toString() : normalizeUrl(loc, current);
        if (!next) throw new Error('Bad redirect');
        current = next;
        continue;
      }
      res.finalUrl = current;
      res.redirected_ = hop > 0;
      return res;
    }
    throw new Error('Too many redirects');
  }

  async readBody(res) {
    const reader = res.body?.getReader();
    if (!reader) return { buf: new Uint8Array(), truncated: false };
    const chunks = [];
    let size = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(Math.min(size, MAX_BYTES));
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.byteLength;
    }
    return { buf, truncated };
  }

  decode(buf, contentType) {
    const m = /charset=([\w-]+)/i.exec(contentType ?? '');
    let charset = m?.[1]?.toLowerCase() ?? 'utf-8';
    if (!m) {
      const head = new TextDecoder('latin1').decode(buf.subarray(0, 2048));
      const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
      if (mm) charset = mm[1].toLowerCase();
    }
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  isBlocked(res) {
    return BLOCK_STATUSES.has(res.status) || res.headers.get('cf-mitigated') === 'challenge';
  }

  /**
   * Fetch the latest Internet Archive snapshot of a URL. `id_` asks the
   * Wayback Machine for the original, un-rewritten HTML, so links still
   * point at the real site and the crawl graph stays intact.
   */
  async fetchArchive(url) {
    await this.politeWait(ARCHIVE_ORIGIN, 0.9);
    if (!this.active) throw new Error('Stopped');
    let res = await this.request(`${ARCHIVE_ORIGIN}/web/2id_/${url}`);
    if (res.status >= 400) {
      // the newest capture is often the bot wall itself: ask the CDX index
      // for the most recent capture that was a real 200 page
      res.body?.cancel().catch(() => {});
      const cdx = await this.request(
        `${ARCHIVE_ORIGIN}/cdx/search/cdx?url=${encodeURIComponent(url)}&filter=statuscode:200&fl=timestamp,original&limit=-1`,
        { accept: 'text/plain' },
      );
      const line = cdx.ok ? (await cdx.text()).trim().split('\n').pop() : '';
      const [ts, original] = line.split(' ');
      if (!/^\d{14}$/.test(ts ?? '') || !original) return null;
      await this.politeWait(ARCHIVE_ORIGIN, 0.9);
      res = await this.request(`${ARCHIVE_ORIGIN}/web/${ts}id_/${original}`);
    }
    const m = /\/web\/(\d{14})id_\/(.+)$/.exec(res.finalUrl);
    if (!m || res.status >= 400) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    res.archivedAt = m[1];
    res.finalUrl = normalizeUrl(m[2].replace(/^(https?:)\/+/, '$1//')) ?? url;
    return res;
  }

  announceArchive(reason, url) {
    if (this.announced) return;
    this.announced = true;
    this.emit('mode', { mode: 'archive', reason, url });
    this.emit('log', { level: 'warn', message: `Live site refused the spiders (${reason}). Asking the Internet Archive for its copy…` });
  }

  noteArchive(url, reason, depth) {
    this.blockedLive = (this.blockedLive ?? 0) + 1;
    if (!this.archiveMode && (depth === 0 || this.blockedLive >= 2)) {
      this.archiveMode = true;
      this.announceArchive(reason, url);
      this.emit('log', { level: 'info', message: 'Time-travel engaged: crawling the Internet Archive copy of this site.' });
    } else {
      this.emit('log', { level: 'info', message: `${url} refused (${reason}), used its Internet Archive copy` });
    }
  }

  async process(job, worker) {
    const id = this.nextId++;
    const { url, depth } = job;
    const origin = new URL(url).origin;

    let robots = null;
    if (this.opts.respectRobots) {
      robots = await this.getRobots(origin);
      if (robots && robots.isAllowed(url, this.opts.userAgent) === false) {
        this.stats.skippedRobots++;
        this.emit('log', { level: 'warn', message: `robots.txt disallows ${url}` });
        return;
      }
    }
    if (!this.archiveMode) await this.politeWait(origin, robots?.getCrawlDelay?.(this.opts.userAgent));
    if (!this.active) return;

    this.emit('fetch', { id, url, depth, worker, from: job.from });
    const t0 = performance.now();
    let attempt = 0;
    while (true) {
      try {
        let res = this.archiveMode ? await this.fetchArchive(url) : await this.request(url);
        if (!res) throw new Error('Not in the Internet Archive');
        if (!res.archivedAt && (res.status === 429 || res.status === 503) && attempt < 2) {
          res.body?.cancel().catch(() => {});
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 800 * 2 ** attempt);
          attempt++;
          continue;
        }
        if (!res.archivedAt && this.opts.archiveFallback && this.isBlocked(res)) {
          // refused (bot wall, auth, rate limit): try the public archived copy
          if (depth === 0) this.announceArchive(`HTTP ${res.status}`, url);
          const arch = await this.fetchArchive(url).catch(() => null);
          if (!arch) res.archiveMissed = true;
          if (arch) {
            this.noteArchive(url, `HTTP ${res.status}`, depth);
            res.body?.cancel().catch(() => {});
            res = arch;
          }
        }
        const ttfb = performance.now() - t0;
        const contentType = res.headers.get('content-type') ?? '';
        const isHtml = /html|xhtml/i.test(contentType) || (!contentType && !isAssetUrl(url));
        let extracted = null;
        let bytes = Number(res.headers.get('content-length')) || 0;
        let truncated = false;
        if (isHtml) {
          const body = await this.readBody(res);
          bytes = body.buf.byteLength;
          truncated = body.truncated;
          extracted = extractPage(this.decode(body.buf, contentType), res.finalUrl, {
            startUrl: this.startUrl,
            includeSubdomains: this.opts.includeSubdomains,
          });
        } else {
          res.body?.cancel().catch(() => {});
        }
        const timeMs = Math.round(performance.now() - t0);
        this.recordPage({ id, job, worker, res, ttfb, timeMs, bytes, contentType, extracted, truncated });
        return;
      } catch (err) {
        if (!this.active) return;
        const message = err?.cause?.code ?? err?.message ?? String(err);
        if (attempt < 1 && !/Blocked/.test(message)) {
          attempt++;
          await sleep(600);
          continue;
        }
        if (this.opts.archiveFallback && !this.archiveMode && !/Blocked|Stopped|Archive/.test(message)) {
          if (depth === 0) this.announceArchive(message, url);
          const arch = await this.fetchArchive(url).catch(() => null);
          if (arch) {
            this.noteArchive(url, message, depth);
            const contentType = arch.headers.get('content-type') ?? '';
            const body = await this.readBody(arch);
            const extracted = extractPage(this.decode(body.buf, contentType), arch.finalUrl, { startUrl: this.startUrl, includeSubdomains: this.opts.includeSubdomains });
            const timeMs = Math.round(performance.now() - t0);
            this.recordPage({ id, job, worker, res: arch, ttfb: timeMs, timeMs, bytes: body.buf.byteLength, contentType, extracted, truncated: body.truncated });
            return;
          }
        }
        this.stats.failed++;
        const record = { id, url, depth, status: 0, error: message, title: '', timeMs: Math.round(performance.now() - t0), from: job.from };
        this.pages.set(url, record);
        this.emit('fail', { id, url, depth, worker, error: message });
        return;
      }
    }
  }

  recordPage({ id, job, worker, res, ttfb, timeMs, bytes, contentType, extracted, truncated }) {
    const { url, depth } = job;
    const finalUrl = res.finalUrl;
    if (finalUrl !== url) this.seen.add(finalUrl);

    const links = extracted?.links ?? [];
    const follow = !(extracted?.robots ?? '').includes('nofollow');
    const outLinks = [];
    for (const l of links) {
      let isNew = false;
      if (l.kind === 'internal') {
        this.inlinks.set(l.url, (this.inlinks.get(l.url) ?? 0) + 1);
        this.edges.push([id, l.url]);
        if (follow && !l.nofollow) isNew = this.enqueue(l.url, depth + 1, id);
      } else if (l.kind === 'external') this.stats.external++;
      else this.stats.assets++;
      outLinks.push({ ...l, isNew });
    }
    this.stats.linksFound += links.length;
    this.stats.crawled++;
    this.stats.bytes += bytes;
    this.stats.totalMs += timeMs;

    // error pages are still read (their navigation keeps the crawl alive), but not audited
    const issues = res.status >= 400 ? [] : [...(extracted?.issues ?? [])];
    if (res.archivedAt) {
      const d = res.archivedAt;
      issues.push({ severity: 'info', code: 'archived', message: `Served from Internet Archive snapshot of ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
    }
    if (depth === 0 && res.status === 404 && new URL(url).pathname !== '/') {
      const home = new URL(url).origin + '/';
      if (this.enqueue(home, 0, id)) this.emit('log', { level: 'warn', message: `Start page is 404, trying the home page ${home}` });
    }
    if (res.status >= 400) issues.unshift({ severity: 'error', code: `http-${res.status}`, message: `HTTP ${res.status}` });
    if (res.redirected_) issues.push({ severity: 'info', code: 'redirect', message: `Redirects to ${finalUrl}` });
    if (timeMs > 3000) issues.push({ severity: 'warn', code: 'slow', message: `Slow response (${timeMs} ms)` });
    if (truncated) issues.push({ severity: 'warn', code: 'truncated', message: 'Body over 6 MB, truncated' });

    const record = {
      id,
      url,
      finalUrl,
      depth,
      from: job.from,
      status: res.status,
      contentType: contentType.split(';')[0],
      timeMs,
      ttfbMs: Math.round(ttfb),
      bytes,
      title: extracted?.title ?? '',
      description: extracted?.description ?? '',
      h1: extracted?.h1 ?? '',
      canonical: extracted?.canonical ?? null,
      lang: extracted?.lang ?? '',
      words: extracted?.words ?? 0,
      images: extracted?.images ?? 0,
      imagesMissingAlt: extracted?.imagesMissingAlt ?? 0,
      headings: extracted?.headings ?? null,
      schema: extracted?.schema ?? [],
      emails: extracted?.emails ?? [],
      server: res.headers.get('server') ?? '',
      linkCounts: {
        internal: links.filter((l) => l.kind === 'internal').length,
        external: links.filter((l) => l.kind === 'external').length,
        asset: links.filter((l) => l.kind === 'asset').length,
      },
      archived: res.archivedAt ?? null,
      archiveMissed: res.archiveMissed ?? false,
      issues,
    };
    this.pages.set(url, record);
    if (finalUrl !== url) this.pages.set(finalUrl, record);

    this.emit('page', {
      ...record,
      worker,
      links: outLinks.slice(0, 400),
      snapshot: extracted?.snapshot ?? [],
    });
  }

  snapshotStats() {
    const elapsed = ((this.finishedAt ?? Date.now()) - this.startedAt) / 1000;
    return {
      state: this.state,
      crawled: this.stats.crawled,
      failed: this.stats.failed,
      queued: this.queue.length,
      inFlight: this.inFlight,
      discovered: this.seen.size,
      linksFound: this.stats.linksFound,
      external: this.stats.external,
      assets: this.stats.assets,
      skippedRobots: this.stats.skippedRobots,
      bytes: this.stats.bytes,
      avgMs: this.stats.crawled ? Math.round(this.stats.totalMs / this.stats.crawled) : 0,
      elapsed,
      rate: elapsed > 0 ? this.stats.crawled / elapsed : 0,
      maxPages: this.opts.maxPages,
    };
  }

  /** unique page records, with link-graph metrics merged in */
  records() {
    const uniq = new Set(this.pages.values());
    return [...uniq].map((p) => ({ ...p, inlinks: this.inlinks.get(p.url) ?? 0 }));
  }

  summary() {
    const recs = this.records();
    const broken = recs.filter((r) => r.status === 0 || r.status >= 400);
    const orphans = recs.filter((r) => r.depth > 0 && (this.inlinks.get(r.url) ?? 0) === 0 && r.from === null);
    return { pages: recs.length, broken: broken.length, sitemapOnly: orphans.length };
  }
}
