import * as cheerio from 'cheerio';
import { normalizeUrl, isAssetUrl, sameScope } from './url-utils.js';

const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption,caption,summary';
const BLOCK_TAGS = new Set(BLOCK_SEL.split(','));
const BLOCKY = new Set([...BLOCK_TAGS, 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'details', 'fieldset', 'hr', 'address', 'center']);
const BLOCKY_SEL = [...BLOCKY].join(',');
const SKIP_SEL = 'script,style,noscript,template,svg,canvas,iframe,form,select,button,[hidden],[aria-hidden="true"]';
const MAX_BLOCKS = 140;
const MAX_BLOCK_CHARS = 700;
const MAX_LINKS = 1500;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;

const squash = (s) => s.replace(/\s+/g, ' ');

/**
 * Turn raw HTML into everything the crawler and the visualiser need:
 *  - metadata + SEO signals
 *  - every outgoing link, classified
 *  - a compact "snapshot": an ordered list of text blocks whose inline links
 *    keep their position, so the client can re-render a faithful reading view
 *    and the spider can walk to each real link.
 */
export function extractPage(html, pageUrl, ctx) {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const base = baseHref ? new URL(baseHref, pageUrl).toString() : pageUrl;

  const title = squash($('head > title').first().text()).trim();
  const meta = (name) =>
    ($(`meta[name="${name}"]`).attr('content') ?? $(`meta[property="${name}"]`).attr('content') ?? '').trim();

  const description = meta('description');
  const robotsMeta = meta('robots').toLowerCase();
  const canonicalRaw = $('link[rel="canonical"]').attr('href');
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, base) : null;
  const lang = $('html').attr('lang') ?? '';
  const h1s = $('h1').map((_, el) => squash($(el).text()).trim()).get().filter(Boolean);
  const headings = { h1: h1s.length, h2: $('h2').length, h3: $('h3').length };
  const og = { title: meta('og:title'), image: meta('og:image'), type: meta('og:type') };

  const jsonLdTypes = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n['@type']) [].concat(n['@type']).forEach((t) => jsonLdTypes.add(String(t)));
        if (n['@graph']) walk(n['@graph']);
      };
      walk(data);
    } catch {
      /* invalid JSON-LD is reported via issues below */
    }
  });

  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src');
    if (!src) return;
    images.push({ src: normalizeUrl(src, base) ?? src, alt: $(el).attr('alt') ?? null });
  });

  // ---- links ---------------------------------------------------------------
  const linkMap = new Map();
  const emails = new Set();
  $('a[href]').each((_, el) => {
    if (linkMap.size >= MAX_LINKS) return false;
    const raw = ($(el).attr('href') ?? '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
    if (raw.startsWith('mailto:')) {
      const e = raw.slice(7).split('?')[0];
      if (e) emails.add(decodeURIComponent(e));
      return;
    }
    if (raw.startsWith('tel:')) return;
    const url = normalizeUrl(raw, base);
    if (!url) return;
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    const text = squash($(el).text()).trim().slice(0, 140) || $(el).attr('title') || $(el).find('img').attr('alt') || '';
    if (!linkMap.has(url)) {
      const kind = isAssetUrl(url)
        ? 'asset'
        : sameScope(url, ctx.startUrl, ctx.includeSubdomains)
          ? 'internal'
          : 'external';
      linkMap.set(url, { url, text, kind, nofollow: rel.includes('nofollow') });
    }
  });

  // ---- snapshot ------------------------------------------------------------
  // Flatten the DOM into reading blocks: real block tags (p, li, h*) become
  // blocks, and runs of loose inline content inside layout containers
  // (div/span soup) are grouped into paragraphs, so div-based sites read well.
  $('script,style,noscript,template').remove();
  // prefer <main>/<article> only when it really holds the page's content
  const bodyLen = squash($('body').text()).length || 1;
  const candidates = [$('main'), $('[role="main"]'), $('article')].filter((c) => c.length === 1);
  const root = candidates.find((c) => squash(c.text()).length / bodyLen > 0.45) ?? $('body');
  root.find(SKIP_SEL).remove();
  // drop chrome that drowns the reading view: language pickers, nav bars, cookie banners
  root.find('a[hreflang], a[lang]').closest('li').remove();
  root.find('[class*="cookie" i], [id*="cookie" i], [class*="consent" i]').remove();
  const navs = root.find('nav, [role="navigation"], [role="search"]');
  const navLen = squash(navs.text()).length;
  if (squash(root.text()).length - navLen > 400) navs.remove();
  const blocks = [];
  const full = () => blocks.length >= MAX_BLOCKS;

  const segmentsOf = (nodes) => {
    const segments = [];
    let chars = 0;
    const push = (seg) => {
      if (chars >= MAX_BLOCK_CHARS) return;
      const room = MAX_BLOCK_CHARS - chars;
      if (seg.text.length > room) seg.text = seg.text.slice(0, room) + '…';
      chars += seg.text.length;
      const prev = segments[segments.length - 1];
      if (!seg.href && !seg.style && prev && !prev.href && !prev.style) prev.text += seg.text;
      else segments.push(seg);
    };
    const walk = (node) => {
      if (chars >= MAX_BLOCK_CHARS) return;
      if (node.type === 'text') {
        const t = squash(node.data ?? '');
        if (t) push({ text: t });
        return;
      }
      if (node.type !== 'tag') return;
      if (node.name === 'br') return push({ text: ' ' });
      if (node.name === 'img') {
        const alt = ($(node).attr('alt') ?? '').trim();
        return alt ? push({ text: ` ${alt} ` }) : undefined;
      }
      if (node.name === 'a') {
        const href = normalizeUrl(($(node).attr('href') ?? '').trim(), base);
        const t = squash($(node).text()).trim() || ($(node).find('img').attr('alt') ?? '').trim();
        if (href && t) {
          const known = linkMap.get(href);
          return push({ text: t, href, kind: known?.kind ?? 'external' });
        }
      }
      const style = node.name === 'code' || node.name === 'kbd' ? 'code' : node.name === 'em' || node.name === 'i' ? 'em' : node.name === 'strong' || node.name === 'b' ? 'strong' : null;
      if (style) {
        const t = squash($(node).text());
        if (t.trim() && !$(node).find('a').length) return push({ text: t, style });
      }
      for (const c of node.children ?? []) walk(c);
    };
    for (const n of nodes) walk(n);
    if (segments.length) {
      segments[0].text = segments[0].text.replace(/^\s+/, '');
      const last = segments[segments.length - 1];
      last.text = last.text.replace(/\s+$/, '');
    }
    return segments.filter((x) => x.text);
  };

  const emit = (tag, nodes) => {
    if (full()) return;
    const segments = segmentsOf(nodes);
    const text = segments.map((x) => x.text).join('');
    if (text.replace(/[\s|·•–—-]/g, '').length < 2) return;
    blocks.push({ tag, segments });
  };

  const isBlocky = (node) => node.type === 'tag' && BLOCKY.has(node.name);
  const hasBlockyInside = (node) => node.type === 'tag' && $(node).find(BLOCKY_SEL).length > 0;

  const walkContainer = (el) => {
    let run = [];
    const flush = () => {
      if (run.length) emit('p', run);
      run = [];
    };
    for (const c of el.children ?? []) {
      if (full()) return;
      if (c.type === 'text' || (c.type === 'tag' && !isBlocky(c) && !hasBlockyInside(c))) {
        run.push(c);
        continue;
      }
      if (c.type !== 'tag') continue;
      flush();
      if (BLOCK_TAGS.has(c.name)) emit(c.name, [c]);
      else if (c.name === 'tr' && !$(c).find('table').length) {
        // a table row reads best as one line: "cell · cell · cell"
        const cells = (c.children ?? []).filter((x) => x.type === 'tag' && (x.name === 'td' || x.name === 'th'));
        const nodes = [];
        cells.forEach((cell, i) => {
          if (i) nodes.push({ type: 'text', data: '  ·  ' });
          nodes.push(cell);
        });
        emit('p', nodes);
      } else walkContainer(c);
    }
    flush();
  };
  walkContainer(root[0]);

  // JS-rendered or link-only pages: synthesise a readable view
  if (blocks.length < 3) {
    if (title) blocks.unshift({ tag: 'h1', segments: [{ text: title }] });
    if (description) blocks.push({ tag: 'p', segments: [{ text: description }] });
    let n = 0;
    for (const l of linkMap.values()) {
      if (n++ > 60) break;
      blocks.push({ tag: 'li', segments: [{ text: l.text || l.url, href: l.url, kind: l.kind }] });
    }
  }

  const bodyText = squash($('body').text());
  for (const m of bodyText.match(EMAIL_RE) ?? []) {
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(m)) emails.add(m);
  }
  const words = bodyText.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  const links = [...linkMap.values()];
  const issues = auditPage({ title, description, h1s, canonical, lang, images, words, robotsMeta, og, html, pageUrl, jsonLdTypes });

  return {
    title,
    description,
    canonical,
    lang,
    robots: robotsMeta,
    h1: h1s[0] ?? '',
    headings,
    og,
    schema: [...jsonLdTypes],
    images: images.length,
    imagesMissingAlt: images.filter((i) => i.alt === null).length,
    words,
    emails: [...emails].slice(0, 50),
    links,
    snapshot: blocks,
    issues,
  };
}

function auditPage({ title, description, h1s, canonical, lang, images, words, robotsMeta, og, html, pageUrl }) {
  const issues = [];
  const add = (severity, code, message) => issues.push({ severity, code, message });

  if (!title) add('error', 'title-missing', 'Missing <title>');
  else if (title.length > 60) add('warn', 'title-long', `Title is ${title.length} chars (keep under 60)`);
  else if (title.length < 10) add('warn', 'title-short', `Title is only ${title.length} chars`);

  if (!description) add('warn', 'desc-missing', 'Missing meta description');
  else if (description.length > 160) add('info', 'desc-long', `Meta description is ${description.length} chars`);

  if (h1s.length === 0) add('warn', 'h1-missing', 'No <h1> on page');
  else if (h1s.length > 1) add('info', 'h1-multiple', `${h1s.length} <h1> elements`);

  if (!lang) add('info', 'lang-missing', 'Missing <html lang>');
  if (!canonical) add('info', 'canonical-missing', 'No canonical link');
  else if (normalizeUrl(pageUrl) !== canonical) add('info', 'canonical-other', 'Canonical points elsewhere');

  const noAlt = images.filter((i) => i.alt === null).length;
  if (noAlt) add('warn', 'img-alt', `${noAlt} image${noAlt > 1 ? 's' : ''} without alt text`);
  if (words < 150) add('info', 'thin-content', `Thin content (${words} words)`);
  if (robotsMeta.includes('noindex')) add('warn', 'noindex', 'Page is marked noindex');
  if (!og.title && !og.image) add('info', 'og-missing', 'No Open Graph tags');
  if (html.length > 1_500_000) add('warn', 'heavy-html', `HTML is ${(html.length / 1e6).toFixed(1)} MB`);
  if (pageUrl.startsWith('http:')) add('warn', 'insecure', 'Served over insecure HTTP');
  return issues;
}
