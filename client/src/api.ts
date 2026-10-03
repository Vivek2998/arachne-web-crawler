import type { CrawlOptions } from './types';

export interface StartResult {
  id: string;
  startUrl: string;
  options: CrawlOptions;
}

export async function startCrawl(url: string, options: Partial<CrawlOptions>): Promise<StartResult> {
  const res = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, options }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function control(id: string, action: 'pause' | 'resume' | 'stop') {
  return fetch(`/api/crawl/${id}/${action}`, { method: 'POST' }).then((r) => r.json());
}

export const exportUrl = (id: string, fmt: 'json' | 'csv' | 'xml') => `/api/crawl/${id}/export.${fmt}`;

type Handlers = Record<string, (data: any) => void>;

/** Subscribe to the crawl's server-sent event stream; returns an unsubscribe fn. */
export function subscribe(id: string, handlers: Handlers): () => void {
  const es = new EventSource(`/api/crawl/${id}/events`);
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
  }
  es.addEventListener('done', () => setTimeout(() => es.close(), 200));
  return () => es.close();
}
