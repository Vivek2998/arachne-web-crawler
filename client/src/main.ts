import './styles.css';
import { Background } from './background';
import { Stage, KIND_COLOR, type Harvest } from './stage';
import { SiteGraph } from './graph';
import { startCrawl, control, subscribe, exportUrl } from './api';
import type { CrawlOptions, DoneEvent, FailEvent, FetchEvent, Issue, LogEvent, PageEvent, PageRecord, Stats } from './types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | number) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
};

// ------------------------------------------------------------------ settings
const DEFAULTS: CrawlOptions = {
  maxPages: 150,
  maxDepth: 4,
  concurrency: 3,
  delayMs: 120,
  timeoutMs: 15000,
  respectRobots: true,
  useSitemap: true,
  includeSubdomains: false,
  userAgent: 'ArachneBot/1.0 (+https://github.com/Vivek2998/arachne-web-crawler)',
};
const SETTINGS_KEY = 'arachne:settings';
function loadSettings(): CrawlOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
let settings = loadSettings();

// ------------------------------------------------------------------ elements
const stageEl = $('#stage');
const panel = $('#panel');
const feed = $('#feed');
const urlInput = $<HTMLInputElement>('#url');
const btnGo = $<HTMLButtonElement>('#btn-go');
const btnPause = $<HTMLButtonElement>('#btn-pause');
const btnStop = $<HTMLButtonElement>('#btn-stop');
const btnExport = $<HTMLButtonElement>('#btn-export');
const exportMenu = $('#export-menu');

const bg = new Background($<HTMLCanvasElement>('#bg'));
const graph = new SiteGraph($<HTMLCanvasElement>('#graph'), $('#graph-tip'));
let activeTab = 'feed';

const stage = new Stage({
  stage: stageEl,
  host: $('#sheet-host'),
  fx: $<HTMLCanvasElement>('#fx'),
  feedTarget: () => {
    const pr = panel.getBoundingClientRect();
    if (pr.width < 10 || pr.bottom < 0 || pr.top > innerHeight) return null;
    if (activeTab === 'feed') {
      const r = feed.getBoundingClientRect();
      if (r.top > innerHeight - 20) return null;
      return r;
    }
    return $('#tab-feed').getBoundingClientRect();
  },
  onHarvest: (hv) => addHarvestRow(hv),
  onRipple: (x, y, s) => bg.ripple(x, y, s, clock),
  onPage: (p) => showAddress(p),
  onDemo: (url) => {
    urlInput.value = url;
    begin();
  },
});

// ------------------------------------------------------------------ state
let crawlId: string | null = null;
let unsubscribe: (() => void) | null = null;
let state: Stats['state'] = 'idle';
const records = new Map<number, PageRecord>();
const issueAgg = new Map<string, { severity: Issue['severity']; label: string; urls: string[] }>();
let feedCount = 0;
let pagesDirty = false;
let issuesDirty = false;
let clock = 0;

// ------------------------------------------------------------------ crawl lifecycle
async function begin() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    toast('Paste a website URL first', 'warn');
    return;
  }
  if (crawlId && (state === 'running' || state === 'paused')) await control(crawlId, 'stop').catch(() => {});
  unsubscribe?.();
  btnGo.disabled = true;
  try {
    const res = await startCrawl(url, settings);
    resetResults();
    crawlId = res.id;
    urlInput.value = res.startUrl;
    state = 'running';
    stage.showWaiting(res.startUrl);
    stage.setSpiderCount(Math.min(4, res.options.concurrency));
    setAddress(res.startUrl, null);
    setRunningUI(true);
    unsubscribe = subscribe(res.id, {
      fetch: onFetch,
      page: onPage,
      fail: onFail,
      stats: onStats,
      log: onLog,
      done: onDone,
    });
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    btnGo.disabled = false;
  }
}

function resetResults() {
  records.clear();
  issueAgg.clear();
  graph.clear();
  feed.replaceChildren(h('div', 'empty', 'Links torn from pages land here.'));
  feedCount = 0;
  pagesDirty = issuesDirty = true;
  for (const id of ['c-feed', 'c-map', 'c-pages', 'c-issues']) $('#' + id).textContent = '0';
  onStats({ state: 'running', crawled: 0, failed: 0, queued: 0, inFlight: 0, discovered: 0, linksFound: 0, external: 0, assets: 0, skippedRobots: 0, bytes: 0, avgMs: 0, elapsed: 0, rate: 0, maxPages: settings.maxPages });
}

function onFetch(e: FetchEvent) {
  // every outgoing request sends a tremor through the web
  const r = stageEl.getBoundingClientRect();
  bg.ripple(r.left + r.width * (0.15 + Math.random() * 0.7), r.top + r.height * (0.1 + Math.random() * 0.5), 0.45, clock);
  $('#live-dot').classList.add('ping');
  setTimeout(() => $('#live-dot').classList.remove('ping'), 180);
  void e;
}

function onPage(p: PageEvent) {
  const rec: PageRecord = { ...p };
  delete (rec as Partial<PageEvent>).links;
  delete (rec as Partial<PageEvent>).snapshot;
  records.set(p.id, rec);
  graph.add(rec, p.links.filter((l) => l.kind === 'internal').map((l) => l.url));
  stage.enqueue(p);
  for (const i of p.issues) addIssue(i, p.url);
  addPageRow(p);
  pagesDirty = issuesDirty = true;
  $('#c-map').textContent = String(graph.size);
  $('#c-pages').textContent = String(records.size);
}

function onFail(f: FailEvent) {
  const rec: PageRecord = { id: f.id, url: f.url, depth: f.depth, from: null, status: 0, timeMs: 0, title: '', issues: [{ severity: 'error', code: 'fetch-failed', message: f.error }], error: f.error };
  records.set(f.id, rec);
  graph.add(rec, []);
  addIssue(rec.issues[0], f.url);
  pushFeed(feedRow('fail', 'ERR', f.url, f.error));
  pagesDirty = issuesDirty = true;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function onStats(s: Stats) {
  state = s.state === 'done' ? state : s.state;
  $('#s-crawled').textContent = String(s.crawled);
  $('#s-queued').textContent = String(s.queued + s.inFlight);
  $('#s-links').textContent = s.linksFound.toLocaleString();
  $('#s-errors').textContent = String(s.failed);
  $('#s-avg').textContent = s.avgMs ? String(s.avgMs) : '–';
  $('#s-rate').textContent = s.rate ? s.rate.toFixed(1) : '–';
  $('#s-time').textContent = fmtTime(s.elapsed);
  $('#hud-bar').style.width = `${Math.min(100, ((s.crawled + s.failed) / Math.max(1, s.maxPages)) * 100)}%`;
  btnPause.classList.toggle('is-paused', s.state === 'paused');
  btnPause.title = s.state === 'paused' ? 'Resume' : 'Pause';
}

function onLog(l: LogEvent) {
  pushFeed(feedRow(l.level === 'error' ? 'fail' : 'log', l.level === 'info' ? 'SYS' : l.level.toUpperCase(), l.message));
  if (l.level === 'error') toast(l.message, 'error');
}

function onDone(d: DoneEvent) {
  state = 'done';
  stage.markDone();
  setRunningUI(false);
  const why = { complete: 'Crawl complete', limit: 'Page limit reached', stopped: 'Crawl stopped', error: 'Crawl failed' }[d.reason];
  if (d.reason !== 'error') toast(`${why} · ${d.pages} pages · ${d.broken} broken`, d.broken ? 'warn' : 'ok');
  pushFeed(feedRow('log', 'END', `${why} — ${d.pages} pages, ${d.broken} broken`));
  $('#live-dot').classList.add('off');
}

function setRunningUI(running: boolean) {
  btnPause.hidden = btnStop.hidden = !running;
  btnExport.disabled = !crawlId;
  btnGo.querySelector('.btn-label')!.textContent = running ? 'Restart' : 'Release';
  $('#live-dot').classList.toggle('off', !running);
}

// ------------------------------------------------------------------ address bar
function setAddress(url: string, status: number | null) {
  $('#addr-url').textContent = url;
  const chip = $('#addr-status');
  chip.hidden = status === null;
  if (status !== null) {
    chip.textContent = status ? String(status) : 'ERR';
    chip.className = `chip ${status >= 200 && status < 300 ? 'ok' : status >= 300 && status < 400 ? 'warn' : 'bad'}`;
  }
}
function showAddress(p: PageEvent | null) {
  if (!p) return setAddress('arachne://idle', null);
  setAddress(p.finalUrl ?? p.url, p.status);
}

// ------------------------------------------------------------------ feed
function pushFeed(row: HTMLElement) {
  $('#feed-empty')?.remove();
  feed.querySelector('.empty')?.remove();
  feed.prepend(row);
  while (feed.childElementCount > 180) feed.lastElementChild!.remove();
  feedCount++;
  $('#c-feed').textContent = String(feedCount);
}

function feedRow(type: 'page' | 'link' | 'fail' | 'log', badge: string, main: string, sub?: string, color?: string) {
  const row = h('div', `frow f-${type} enter`);
  const b = h('span', 'fbadge', badge);
  if (color) row.style.setProperty('--c', color);
  const body = h('div', 'fbody');
  body.append(h('span', 'fmain', main));
  if (sub) body.append(h('span', 'fsub', sub));
  row.append(b, body);
  requestAnimationFrame(() => row.classList.remove('enter'));
  return row;
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function addPageRow(p: PageEvent) {
  const row = feedRow('page', String(p.status), p.title || pathOf(p.url), `${pathOf(p.url)} · ${p.timeMs} ms · ${p.links.length} links`);
  row.addEventListener('click', () => openDetails(p.id));
  pushFeed(row);
}

function addHarvestRow(hv: Harvest) {
  const color = hv.kind === 'internal' && !hv.isNew ? KIND_COLOR.seen : KIND_COLOR[hv.kind];
  const badge = hv.kind === 'internal' ? (hv.isNew ? 'NEW' : 'INT') : hv.kind === 'external' ? 'EXT' : 'AST';
  const row = feedRow('link', badge, hv.text || hv.url, hv.url, color);
  row.classList.add('landed');
  row.addEventListener('click', () => window.open(hv.url, '_blank', 'noopener'));
  pushFeed(row);
}

// ------------------------------------------------------------------ issues
const LABELS: Record<string, string> = {
  'title-missing': 'Missing <title>',
  'title-long': 'Title longer than 60 characters',
  'title-short': 'Title too short',
  'desc-missing': 'Missing meta description',
  'desc-long': 'Meta description longer than 160 characters',
  'h1-missing': 'No <h1> heading',
  'h1-multiple': 'Multiple <h1> headings',
  'lang-missing': 'Missing <html lang>',
  'canonical-missing': 'No canonical link',
  'canonical-other': 'Canonical points to another URL',
  'img-alt': 'Images without alt text',
  'thin-content': 'Thin content (< 150 words)',
  noindex: 'Marked noindex',
  'og-missing': 'No Open Graph tags',
  'heavy-html': 'Very heavy HTML',
  insecure: 'Served over plain HTTP',
  redirect: 'Redirects',
  slow: 'Slow response (> 3 s)',
  truncated: 'Body truncated (> 6 MB)',
  'fetch-failed': 'Request failed',
};
function addIssue(i: Issue, url: string) {
  const label = LABELS[i.code] ?? (i.code.startsWith('http-') ? `HTTP ${i.code.slice(5)} responses` : i.message);
  const g = issueAgg.get(i.code) ?? { severity: i.severity, label, urls: [] };
  g.urls.push(url);
  issueAgg.set(i.code, g);
}

function renderIssues() {
  const list = $('#issues-list');
  const sev = { error: 0, warn: 1, info: 2 };
  const groups = [...issueAgg.entries()].sort((a, b) => sev[a[1].severity] - sev[b[1].severity] || b[1].urls.length - a[1].urls.length);
  $('#c-issues').textContent = String(groups.reduce((s, [, g]) => s + (g.severity === 'info' ? 0 : g.urls.length), 0));
  if (!groups.length) return list.replaceChildren(h('div', 'empty', records.size ? 'No issues found. Clean site! 🕸' : 'Audit findings show up here.'));
  const open = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.code));
  list.replaceChildren(
    ...groups.map(([code, g]) => {
      const d = h('details', `issue sev-${g.severity}`);
      d.dataset.code = code;
      if (open.has(code)) d.open = true;
      const s = h('summary');
      s.append(h('span', 'sev-dot'), h('span', 'issue-label', g.label), h('span', 'issue-count', g.urls.length));
      const ul = h('ul');
      for (const u of g.urls.slice(0, 50)) {
        const li = h('li');
        const a = h('a', undefined, pathOf(u) || u);
        a.setAttribute('href', u);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        li.append(a);
        ul.append(li);
      }
      if (g.urls.length > 50) ul.append(h('li', 'muted', `…and ${g.urls.length - 50} more (see CSV export)`));
      d.append(s, ul);
      return d;
    }),
  );
}

// ------------------------------------------------------------------ pages table
let pageFilter = 'all';
function renderPages() {
  const list = $('#pages-list');
  const q = $<HTMLInputElement>('#pages-q').value.trim().toLowerCase();
  const rows = [...records.values()]
    .filter((r) => {
      if (pageFilter === 'ok' && !(r.status >= 200 && r.status < 300)) return false;
      if (pageFilter === 'redir' && !(r.status >= 300 && r.status < 400)) return false;
      if (pageFilter === 'bad' && !(r.status === 0 || r.status >= 400)) return false;
      return !q || r.url.toLowerCase().includes(q) || r.title.toLowerCase().includes(q);
    })
    .sort((a, b) => a.id - b.id);
  if (!rows.length) return list.replaceChildren(h('div', 'empty', records.size ? 'No pages match.' : 'No pages yet.'));
  list.replaceChildren(
    ...rows.slice(0, 500).map((r) => {
      const row = h('button', 'prow');
      const st = h('span', `pstatus ${r.status >= 200 && r.status < 300 ? 'ok' : r.status >= 300 && r.status < 400 ? 'warn' : 'bad'}`, r.status || 'ERR');
      const body = h('span', 'pbody');
      body.append(h('span', 'ptitle', r.title || '(untitled)'), h('span', 'purl', pathOf(r.url)));
      row.append(st, body, h('span', 'pms', r.timeMs ? `${r.timeMs}ms` : ''), h('span', 'pdepth', `d${r.depth}`));
      row.addEventListener('click', () => openDetails(r.id));
      return row;
    }),
  );
  if (rows.length > 500) list.append(h('div', 'empty', `Showing 500 of ${rows.length}. Use the filter or export CSV.`));
}

// ------------------------------------------------------------------ details dialog
function openDetails(id: number) {
  const r = records.get(id);
  if (!r) return;
  const dlg = $<HTMLDialogElement>('#details');
  const body = $('#details-body');
  const head = h('header', 'dlg-head');
  const title = h('div');
  title.append(h('h2', undefined, r.title || '(untitled)'));
  const link = h('a', 'detail-url', r.finalUrl ?? r.url);
  link.setAttribute('href', r.finalUrl ?? r.url);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  title.append(link);
  const close = h('button', 'icon-btn small', '✕');
  close.addEventListener('click', () => dlg.close());
  head.append(title, close);

  const kv = h('div', 'kv');
  const add = (k: string, v: string | number | undefined | null) => {
    if (v === undefined || v === null || v === '') return;
    kv.append(h('span', 'k', k), h('span', 'v', v));
  };
  add('Status', r.status || 'failed');
  add('Response time', r.timeMs ? `${r.timeMs} ms (TTFB ${r.ttfbMs ?? '–'} ms)` : undefined);
  add('Size', r.bytes ? `${(r.bytes / 1024).toFixed(1)} KB` : undefined);
  add('Depth', r.depth);
  add('Content type', r.contentType);
  add('Server', r.server);
  add('Words', r.words);
  add('H1', r.h1);
  add('Description', r.description);
  add('Canonical', r.canonical);
  add('Language', r.lang);
  add('Links', r.linkCounts ? `${r.linkCounts.internal} internal · ${r.linkCounts.external} external · ${r.linkCounts.asset} assets` : undefined);
  add('Images', r.images !== undefined ? `${r.images} (${r.imagesMissingAlt ?? 0} missing alt)` : undefined);
  add('Headings', r.headings ? `h1 ${r.headings.h1} · h2 ${r.headings.h2} · h3 ${r.headings.h3}` : undefined);
  add('Structured data', r.schema?.length ? r.schema.join(', ') : undefined);
  add('Emails found', r.emails?.length ? r.emails.join(', ') : undefined);
  add('Error', r.error);

  const iss = h('div', 'detail-issues');
  iss.append(h('h3', undefined, r.issues.length ? `Audit (${r.issues.length})` : 'Audit: no issues'));
  for (const i of r.issues) {
    const row = h('div', `issue-row sev-${i.severity}`);
    row.append(h('span', 'sev-dot'), h('span', undefined, i.message));
    iss.append(row);
  }
  body.replaceChildren(head, kv, iss);
  dlg.showModal();
}
graph.onSelect = (url) => {
  const r = [...records.values()].find((x) => x.url === url || x.finalUrl === url);
  if (r) openDetails(r.id);
};

// ------------------------------------------------------------------ toasts
function toast(msg: string, kind: 'ok' | 'warn' | 'error' = 'ok') {
  const t = h('div', `toast t-${kind}`, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
}

// ------------------------------------------------------------------ UI wiring
$('#crawl-form').addEventListener('submit', (e) => {
  e.preventDefault();
  begin();
});
btnPause.addEventListener('click', () => {
  if (!crawlId) return;
  control(crawlId, state === 'paused' ? 'resume' : 'pause').then((r) => (state = r.state));
});
btnStop.addEventListener('click', () => crawlId && control(crawlId, 'stop'));

btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!crawlId) return;
  for (const a of exportMenu.querySelectorAll<HTMLAnchorElement>('a')) a.href = exportUrl(crawlId, a.dataset.fmt as 'json');
  exportMenu.hidden = !exportMenu.hidden;
  btnExport.setAttribute('aria-expanded', String(!exportMenu.hidden));
});
document.addEventListener('click', () => (exportMenu.hidden = true));

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab!;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll<HTMLElement>('.tab-body').forEach((b) => b.classList.toggle('active', b.dataset.body === activeTab));
    graph.visible = activeTab === 'map';
    if (activeTab === 'pages') pagesDirty = true;
    if (activeTab === 'issues') issuesDirty = true;
  });
}
$('#btn-expand').addEventListener('click', () => {
  panel.classList.toggle('expanded');
  window.dispatchEvent(new Event('resize'));
});
$('#pages-q').addEventListener('input', () => (pagesDirty = true));
for (const chip of document.querySelectorAll<HTMLButtonElement>('#pages-filter .chip-btn')) {
  chip.addEventListener('click', () => {
    pageFilter = chip.dataset.f!;
    document.querySelectorAll('#pages-filter .chip-btn').forEach((c) => c.classList.toggle('active', c === chip));
    pagesDirty = true;
  });
}

const PACES = [0.5, 1, 1.5, 2.5];
let paceIdx = 1;
$('#btn-pace').addEventListener('click', () => {
  paceIdx = (paceIdx + 1) % PACES.length;
  stage.userPace = PACES[paceIdx];
  $('#btn-pace').textContent = `${PACES[paceIdx]}×`;
});

// settings dialog
const settingsDlg = $<HTMLDialogElement>('#settings');
const settingsForm = $<HTMLFormElement>('#settings-form');
function fillSettings(s: CrawlOptions) {
  for (const [k, v] of Object.entries(s)) {
    const input = settingsForm.elements.namedItem(k) as HTMLInputElement | null;
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = String(v);
  }
}
$('#btn-settings').addEventListener('click', () => {
  fillSettings(settings);
  settingsDlg.showModal();
});
$('#settings-reset').addEventListener('click', () => fillSettings(DEFAULTS));
settingsDlg.addEventListener('close', () => {
  if (settingsDlg.returnValue !== 'save') return;
  const next = { ...settings } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS)) {
    const input = settingsForm.elements.namedItem(k) as HTMLInputElement | null;
    if (!input) continue;
    next[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  settings = next as unknown as CrawlOptions;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: settings still apply for this session */
  }
  toast('Settings saved');
});

document.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).closest('input, textarea, select');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    urlInput.focus();
    urlInput.select();
  }
});

// ------------------------------------------------------------------ main loop
let last = performance.now();
let uiTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  bg.render(clock, dt);
  stage.update(dt, clock);
  stage.draw();
  if (graph.visible) {
    graph.step(dt);
    graph.draw();
  } else if (graph.size) graph.step(dt * 0.5);

  uiTimer += dt;
  if (uiTimer > 0.4) {
    uiTimer = 0;
    if (pagesDirty && activeTab === 'pages') {
      pagesDirty = false;
      renderPages();
    }
    if (issuesDirty) {
      issuesDirty = false;
      renderIssues();
    }
    const backlog = stage.backlog;
    const bl = $('#addr-backlog');
    bl.hidden = backlog < 1;
    bl.textContent = `+${backlog} in playback`;
  }
  requestAnimationFrame(frame);
}

stage.showHero();
requestAnimationFrame(frame);
setTimeout(() => urlInput.focus({ preventScroll: true }), 300);
