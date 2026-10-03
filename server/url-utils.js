import dns from 'node:dns/promises';
import net from 'node:net';

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src)$/i;

const ASSET_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|pdf|zip|rar|7z|gz|tgz|tar|dmg|exe|msi|apk|iso|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|woff2?|ttf|otf|eot|css|js|mjs|map)$/i;

/**
 * Normalise a URL so that trivially different spellings of the same page
 * collapse into one key: lower-case host, no fragment, no default port,
 * no tracking parameters, sorted query string.
 */
export function normalizeUrl(input, base) {
  let u;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  return u.toString();
}

export function isAssetUrl(url) {
  try {
    return ASSET_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Registrable-ish domain: last two labels (good enough without a PSL for scope checks). */
export function rootDomain(hostname) {
  const parts = hostname.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  // Handle common second-level public suffixes like co.uk, com.au, co.in
  if (/^(co|com|net|org|gov|edu|ac)$/.test(sld) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function sameScope(url, startUrl, includeSubdomains) {
  try {
    const a = new URL(url);
    const b = new URL(startUrl);
    const ha = a.hostname.replace(/^www\./, '');
    const hb = b.hostname.replace(/^www\./, '');
    if (ha === hb) return true;
    return includeSubdomains && rootDomain(ha) === rootDomain(hb);
  } catch {
    return false;
  }
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

const dnsCache = new Map();

/**
 * Guard against SSRF: refuse hosts that resolve to loopback / private ranges
 * unless the operator explicitly allows it (ALLOW_PRIVATE_NETWORKS=1).
 */
export async function assertPublicHost(url) {
  if (process.env.ALLOW_PRIVATE_NETWORKS === '1') return;
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Blocked private host: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
    return;
  }
  let addrs = dnsCache.get(host);
  if (!addrs) {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
    dnsCache.set(host, addrs);
    setTimeout(() => dnsCache.delete(host), 5 * 60_000).unref();
  }
  if (!addrs.length) throw new Error(`DNS lookup failed for ${host}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Blocked: ${host} resolves to private address ${address}`);
  }
}
