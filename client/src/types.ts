export type LinkKind = 'internal' | 'external' | 'asset';

export interface Segment {
  text: string;
  href?: string;
  kind?: LinkKind;
  style?: 'code' | 'em' | 'strong';
}

export interface Block {
  tag: string;
  segments: Segment[];
}

export interface PageLink {
  url: string;
  text: string;
  kind: LinkKind;
  nofollow: boolean;
  isNew: boolean;
}

export interface Issue {
  severity: 'error' | 'warn' | 'info';
  code: string;
  message: string;
}

export interface PageRecord {
  id: number;
  url: string;
  finalUrl?: string;
  depth: number;
  from: number | null;
  status: number;
  contentType?: string;
  timeMs: number;
  ttfbMs?: number;
  bytes?: number;
  title: string;
  description?: string;
  h1?: string;
  canonical?: string | null;
  lang?: string;
  words?: number;
  images?: number;
  imagesMissingAlt?: number;
  headings?: { h1: number; h2: number; h3: number } | null;
  schema?: string[];
  emails?: string[];
  server?: string;
  linkCounts?: { internal: number; external: number; asset: number };
  issues: Issue[];
  error?: string;
  archived?: string | null;
  archiveMissed?: boolean;
}

export interface PageEvent extends PageRecord {
  worker: number;
  links: PageLink[];
  snapshot: Block[];
}

export interface FetchEvent {
  id: number;
  url: string;
  depth: number;
  worker: number;
  from: number | null;
}

export interface FailEvent {
  id: number;
  url: string;
  depth: number;
  worker: number;
  error: string;
}

export interface Stats {
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'done';
  crawled: number;
  failed: number;
  queued: number;
  inFlight: number;
  discovered: number;
  linksFound: number;
  external: number;
  assets: number;
  skippedRobots: number;
  bytes: number;
  avgMs: number;
  elapsed: number;
  rate: number;
  maxPages: number;
}

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
  respectRobots: boolean;
  useSitemap: boolean;
  includeSubdomains: boolean;
  archiveFallback: boolean;
  userAgent: string;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DoneEvent {
  reason: 'complete' | 'limit' | 'stopped' | 'error';
  pages: number;
  broken: number;
}

export interface ModeEvent {
  mode: 'archive';
  reason: string;
  url: string;
}
