import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Crawler, sanitizeOptions, DEFAULTS } from './crawler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 6;
const SESSION_TTL = 60 * 60_000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

/** @type {Map<string, {crawler: Crawler, events: any[], clients: Set<any>, createdAt: number}>} */
const sessions = new Map();

function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL || (s.crawler.state === 'done' && !s.clients.size && now - s.crawler.finishedAt > 15 * 60_000)) {
      s.crawler.stop();
      sessions.delete(id);
    }
  }
}
setInterval(gc, 60_000).unref();

function broadcast(session, type, data) {
  const ev = { seq: session.events.length, type, data };
  // Keep the replay log lean: drop the heavy snapshot for old pages
  session.events.push(ev);
  if (type === 'page' && session.events.length > 400) {
    const old = session.events[session.events.length - 400];
    if (old?.type === 'page' && old.data.snapshot) old.data = { ...old.data, snapshot: [] };
  }
  const line = `id: ${ev.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) res.write(line);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));
app.get('/api/defaults', (_req, res) => res.json(DEFAULTS));

app.post('/api/crawl', (req, res) => {
  gc();
  let { url, options } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'URL is required' });
  url = url.trim();
  if (/^(sandbox|sandbox\.arachne)\/?$/i.test(url)) url = 'https://sandbox.arachne/';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const running = [...sessions.values()].filter((s) => s.crawler.active).length;
  if (running >= MAX_SESSIONS) return res.status(429).json({ error: 'Too many crawls running, try again shortly' });

  let crawler;
  try {
    crawler = new Crawler(url, sanitizeOptions(options));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const id = crypto.randomUUID();
  const session = { crawler, events: [], clients: new Set(), createdAt: Date.now() };
  sessions.set(id, session);

  for (const type of ['fetch', 'page', 'fail', 'stats', 'log', 'mode', 'done']) {
    crawler.on(type, (data) => broadcast(session, type, data));
  }
  broadcast(session, 'init', { id, startUrl: crawler.startUrl, options: crawler.opts });
  // start on next tick so the client can subscribe first; replay covers the rest
  setTimeout(() => crawler.start().catch((e) => broadcast(session, 'log', { level: 'error', message: e.message })), 30);
  res.status(201).json({ id, startUrl: crawler.startUrl, options: crawler.opts });
});

app.get('/api/crawl/:id/events', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  const from = Number(req.headers['last-event-id'] ?? -1) + 1;
  for (const ev of session.events.slice(from)) {
    res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }
  session.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    session.clients.delete(res);
  });
});

app.post('/api/crawl/:id/:action', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown crawl' });
  const { crawler } = session;
  switch (req.params.action) {
    case 'pause':
      crawler.pause();
      break;
    case 'resume':
      crawler.resume();
      break;
    case 'stop':
      crawler.stop();
      break;
    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
  broadcast(session, 'stats', crawler.snapshotStats());
  res.json({ state: crawler.state });
});

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' | ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const xmlEsc = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

app.get('/api/crawl/:id/export.:format', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();
  const { crawler } = session;
  const records = crawler.records().sort((a, b) => a.id - b.id);
  const host = new URL(crawler.startUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const stamp = new Date().toISOString().slice(0, 10);

  if (req.params.format === 'json') {
    res.setHeader('content-disposition', `attachment; filename="arachne-${host}-${stamp}.json"`);
    return res.json({ startUrl: crawler.startUrl, options: crawler.opts, stats: crawler.snapshotStats(), pages: records });
  }
  if (req.params.format === 'csv') {
    const cols = ['url', 'finalUrl', 'status', 'depth', 'title', 'description', 'h1', 'words', 'timeMs', 'ttfbMs', 'bytes', 'inlinks', 'internalLinks', 'externalLinks', 'imagesMissingAlt', 'canonical', 'issues', 'error'];
    const rows = records.map((r) =>
      [r.url, r.finalUrl, r.status, r.depth, r.title, r.description, r.h1, r.words, r.timeMs, r.ttfbMs, r.bytes, r.inlinks, r.linkCounts?.internal, r.linkCounts?.external, r.imagesMissingAlt, r.canonical, (r.issues ?? []).map((i) => i.message), r.error]
        .map(csvCell)
        .join(','),
    );
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="arachne-${host}-${stamp}.csv"`);
    return res.send('﻿' + [cols.join(','), ...rows].join('\n'));
  }
  if (req.params.format === 'xml') {
    const urls = records.filter((r) => r.status >= 200 && r.status < 300 && /html/.test(r.contentType ?? '') && !r.issues?.some((i) => i.code === 'noindex'));
    const uniq = [...new Set(urls.map((r) => r.canonical || r.finalUrl || r.url))];
    const body = uniq.map((u) => `  <url><loc>${xmlEsc(u)}</loc></url>`).join('\n');
    res.setHeader('content-type', 'application/xml');
    res.setHeader('content-disposition', `attachment; filename="sitemap-${host}.xml"`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
  }
  res.status(400).json({ error: 'Unknown format' });
});

const dist = path.resolve(__dirname, '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`\n  🕷  Arachne crawler listening on http://localhost:${PORT}\n`);
});
