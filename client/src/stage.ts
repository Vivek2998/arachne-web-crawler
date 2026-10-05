import { Spider, PALETTES } from './spider';
import {
  V, v, clamp, damp, dist, rand, pick, cubicBezier, easeInOutCubic, easeOutCubic, prefersReducedMotion, TAU,
} from './math';
import type { Block, LinkKind, PageEvent } from './types';
import { scramble } from './scramble';

export const KIND_COLOR: Record<LinkKind | 'seen', string> = {
  internal: '#5ee7ff',
  seen: '#a48bff',
  external: '#ff4fb0',
  asset: '#ffb84d',
};

interface Target {
  el: HTMLAnchorElement;
  url: string;
  text: string;
  kind: LinkKind;
  isNew: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  claimed: boolean;
  done: boolean;
}

type AgentState = 'drop' | 'wander' | 'seek' | 'grab' | 'poke';

interface Agent {
  sp: Spider;
  state: AgentState;
  t: number;
  target: Target | null;
  goal: V;
  anchor: V | null;
  trail: { x: number; y: number; t: number }[];
  drop: { from: number; to: number; dur: number } | null;
  nextWander: number;
  grabbedAt: V | null;
}

interface Flyer {
  el: HTMLElement;
  p: V[];
  t: number;
  dur: number;
  spin: number;
  color: string;
  origin: V; // world point the link was torn from
  onLand: () => void;
}

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  ch: string;
  color: string;
  rot: number;
  vr: number;
}

interface Strand {
  a: V;
  b: V;
  born: number;
  color: string;
  dying: number;
}

export interface Harvest {
  url: string;
  text: string;
  kind: LinkKind;
  isNew: boolean;
  pageUrl: string;
}

type Phase = 'hero' | 'waiting' | 'enter' | 'harvest' | 'linger';

interface StageOptions {
  stage: HTMLElement;
  host: HTMLElement;
  fx: HTMLCanvasElement;
  feedTarget: () => DOMRect | null;
  onHarvest: (h: Harvest) => void;
  onRipple: (x: number, y: number, strength: number) => void;
  onPage: (p: PageEvent | null) => void;
  onDemo: (url: string) => void;
}

const GLYPHS = '01<>/\\{}[]#$%&*+=?@ABCDEF';

export class Stage {
  private o: StageOptions;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private rect = new DOMRect();
  private sheet: HTMLElement | null = null;
  private sheetH = 0;
  camY = 0;
  private camTarget = 0;
  private userScrollUntil = 0;
  private agents: Agent[] = [];
  private targets: Target[] = [];
  private flyers: Flyer[] = [];
  private shards: Shard[] = [];
  private strands: Strand[] = [];
  private queue: PageEvent[] = [];
  private current: PageEvent | null = null;
  private phase: Phase = 'hero';
  private phaseT = 0;
  private time = 0;
  private nextGlitch = 2;
  private pointer: { x: number; y: number; at: number } | null = null;
  private scan: { t: number; dur: number } | null = null;
  private crawlDone = false;
  private reduced = prefersReducedMotion();
  userPace = 1;
  private pace = 1;

  constructor(o: StageOptions) {
    this.o = o;
    this.ctx = o.fx.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => (this.reduced = e.matches));

    o.stage.addEventListener(
      'wheel',
      (e) => {
        if (!this.sheet) return;
        e.preventDefault();
        this.camTarget = clamp(this.camTarget + e.deltaY, 0, this.maxCam);
        this.userScrollUntil = this.time + 2.5;
      },
      { passive: false },
    );
    let touchY: number | null = null;
    o.stage.addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
    o.stage.addEventListener(
      'touchmove',
      (e) => {
        if (touchY === null) return;
        const y = e.touches[0].clientY;
        this.camTarget = clamp(this.camTarget + (touchY - y), 0, this.maxCam);
        touchY = y;
        this.userScrollUntil = this.time + 2.5;
      },
      { passive: true },
    );
    o.stage.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top + this.camY, at: this.time };
    });
    o.stage.addEventListener('pointerleave', () => (this.pointer = null));
    o.stage.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a?.dataset.demo) {
        e.preventDefault();
        this.o.onDemo(a.dataset.demo);
        return;
      }
      if (a) return;
      // poke: nearest spider rushes to the click
      const p = v(e.clientX - this.rect.left, e.clientY - this.rect.top + this.camY);
      const ag = this.agents
        .filter((x) => x.state === 'wander' || x.state === 'poke')
        .sort((a1, a2) => dist(a1.sp.pos, p) - dist(a2.sp.pos, p))[0];
      if (ag) {
        ag.state = 'poke';
        ag.goal = p;
        ag.t = 0;
      }
      this.o.onRipple(e.clientX, e.clientY, 0.6);
    });
  }

  private get viewH() {
    return this.rect.height;
  }
  private get maxCam() {
    return Math.max(0, this.sheetH - this.viewH + 60);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this.o.fx;
    c.width = Math.round(innerWidth * this.dpr);
    c.height = Math.round(innerHeight * this.dpr);
    this.rect = this.o.stage.getBoundingClientRect();
    if (this.sheet) {
      this.sheetH = this.sheet.offsetHeight;
      this.measureTargets();
    }
  }

  // ---------------------------------------------------------------- spiders
  setSpiderCount(n: number) {
    n = clamp(n, 1, 4);
    while (this.agents.length > n) this.agents.pop();
    const sheetBox = this.sheetBounds();
    while (this.agents.length < n) {
      const i = this.agents.length;
      const x = rand(sheetBox.l + 60, sheetBox.r - 60);
      const land = this.camY + rand(this.viewH * 0.3, this.viewH * 0.65);
      const sp = new Spider(x, this.camY - 90, innerWidth < 700 ? 0.78 : 1, PALETTES[i % PALETTES.length]);
      sp.heading = Math.PI / 2;
      sp.airborne = 1;
      this.agents.push({
        sp,
        state: 'drop',
        t: -i * 0.35,
        target: null,
        goal: v(x, land),
        anchor: null,
        trail: [],
        drop: { from: this.camY - 90, to: land, dur: 1.05 },
        nextWander: 0,
        grabbedAt: null,
      });
    }
  }

  private sheetBounds() {
    const w = this.rect.width;
    if (!this.sheet) return { l: 20, r: w - 20 };
    const l = this.sheet.offsetLeft;
    return { l: Math.max(16, l - 10), r: Math.min(w - 16, l + this.sheet.offsetWidth + 10) };
  }

  // ---------------------------------------------------------------- pages
  showHero() {
    this.queue = [];
    this.current = null;
    this.crawlDone = false;
    this.mountSheet(buildHero(), 'hero');
    this.o.onPage(null);
    if (!this.agents.length) this.setSpiderCount(2);
  }

  showWaiting(url: string) {
    this.queue = [];
    this.current = null;
    this.crawlDone = false;
    this.mountSheet(buildWaiting(url), 'waiting');
  }

  enqueue(p: PageEvent) {
    this.queue.push(p);
    // under heavy load keep the show moving: only the freshest pages get the full treatment
    while (this.queue.length > 40) this.queue.shift();
  }

  get backlog() {
    return this.queue.length;
  }

  markDone() {
    this.crawlDone = true;
  }

  /** visual "rewind" when the crawl switches to the Internet Archive */
  timeWarp(label: string) {
    const st = this.o.stage;
    st.classList.remove('warp');
    void st.offsetWidth;
    st.classList.add('warp');
    setTimeout(() => st.classList.remove('warp'), 1600);
    const badge = document.createElement('div');
    badge.className = 'warp-badge';
    badge.textContent = label;
    st.appendChild(badge);
    setTimeout(() => badge.remove(), 2600);
    const r = this.rect;
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.o.onRipple(r.left + r.width / 2, r.top + r.height / 2, 1.2 - i * 0.12), i * 140);
    }
  }

  private mountSheet(el: HTMLElement, phase: Phase) {
    const old = this.sheet;
    const oldCam = this.camY;
    if (old) {
      old.classList.add('sheet-out');
      old.style.pointerEvents = 'none';
      setTimeout(() => old.remove(), 650);
    }
    el.classList.add('sheet-in');
    this.o.host.appendChild(el);
    this.sheet = el;
    this.sheetH = el.offsetHeight;
    this.camY = this.camTarget = 0;
    this.userScrollUntil = 0;
    el.style.transform = 'translate3d(0,0,0)';

    // keep spiders where they are on screen while the page under them changes
    for (const a of this.agents) {
      a.sp.translate(0, -oldCam);
      a.trail = [];
      a.anchor = null;
      a.target = null;
      if (a.drop) {
        a.drop.from -= oldCam;
        a.drop.to -= oldCam;
      } else {
        a.state = 'wander';
        a.nextWander = 0;
      }
      a.goal.y -= oldCam;
    }
    for (const s of this.strands) {
      s.a.y -= oldCam;
      s.b.y -= oldCam;
      s.dying = s.dying || this.time;
    }
    this.targets = [];
    this.phase = phase;
    this.phaseT = 0;
    this.scan = this.reduced ? null : { t: 0, dur: 0.9 };
    if (phase === 'hero') this.pickTargets(6, true);
  }

  private nextPage() {
    const p = this.queue.shift()!;
    this.current = p;
    this.mountSheet(buildSheet(p), 'enter');
    this.o.onPage(p);
    const r = this.rect;
    this.o.onRipple(r.left + r.width / 2, r.top + 120, 1);
  }

  // ---------------------------------------------------------------- targets
  private measure(t: Target) {
    const r = t.el.getClientRects()[0] ?? t.el.getBoundingClientRect();
    t.x = r.left - this.rect.left;
    t.y = r.top - this.rect.top + this.camY;
    t.w = r.width;
    t.h = r.height;
  }

  private measureTargets() {
    for (const t of this.targets) if (!t.done) this.measure(t);
  }

  private pickTargets(budget: number, all = false) {
    if (!this.sheet) return;
    const linkInfo = new Map(this.current?.links.map((l) => [l.url, l]) ?? []);
    const used = new Set(this.targets.map((t) => t.url));
    const pool: Target[] = [];
    for (const el of this.sheet.querySelectorAll<HTMLAnchorElement>('a[data-k]')) {
      if (el.classList.contains('is-harvested')) continue;
      const url = el.dataset.url!;
      if (used.has(url)) continue;
      used.add(url);
      const info = linkInfo.get(url);
      const t: Target = {
        el,
        url,
        text: el.textContent ?? '',
        kind: (el.dataset.k as LinkKind) ?? 'external',
        isNew: info?.isNew ?? false,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        claimed: false,
        done: false,
      };
      this.measure(t);
      if (t.w < 3) continue;
      pool.push(t);
    }
    if (!pool.length) return;
    // prefer links near the current view
    const top = this.camY + 40;
    const windowH = all ? this.viewH * 0.8 : this.viewH * 2.8;
    let near = pool.filter((t) => t.y > top - 20 && t.y < top + windowH);
    if (near.length < budget && !all) near = pool.filter((t) => t.y > top - 20).slice(0, budget * 3);
    if (!near.length) near = pool;
    const score = (t: Target) => (t.kind === 'internal' && t.isNew ? 3 : t.kind === 'internal' ? 2 : t.kind === 'asset' ? 1.6 : 1.4) + Math.random();
    const chosen = near
      .sort((a, b) => score(b) - score(a))
      .slice(0, budget)
      .sort((a, b) => a.y - b.y);
    for (const t of chosen) t.el.classList.add('is-queued');
    this.targets.push(...chosen);
  }

  private claimTarget(a: Agent): Target | null {
    let best: Target | null = null;
    let bestCost = Infinity;
    const p = a.sp.pos;
    for (const t of this.targets) {
      if (t.claimed || t.done) continue;
      const c = v(t.x + Math.min(t.w, 140) / 2, t.y + t.h / 2);
      const offscreen = t.y < this.camY - 20 ? 500 : 0;
      const cost = dist(p, c) + Math.abs(c.y - (p.y + 40)) * 0.35 + offscreen;
      if (cost < bestCost) {
        bestCost = cost;
        best = t;
      }
    }
    if (best) {
      best.claimed = true;
      best.el.classList.add('is-targeted');
      best.el.style.setProperty('--hue', a.sp.palette.leg);
    }
    return best;
  }

  // ---------------------------------------------------------------- update
  update(dt: number, now: number) {
    this.time = now;
    this.phaseT += dt;
    this.rect = this.o.stage.getBoundingClientRect();

    const backlog = this.queue.length;
    this.pace = this.userPace * (1 + Math.min(backlog, 20) * 0.055);
    for (const a of this.agents) a.sp.pace = this.pace * (a.state === 'wander' ? 0.5 : 1);

    // ---- phase machine
    if (this.phase === 'waiting' && this.queue.length && this.phaseT > 0.6) this.nextPage();
    else if (this.phase === 'enter' && this.phaseT > (this.reduced ? 0.1 : 0.75)) {
      const budget = backlog > 25 ? 2 : backlog > 12 ? 3 : backlog > 5 ? 5 : backlog > 1 ? 7 : 10;
      this.pickTargets(budget);
      this.phase = 'harvest';
      this.phaseT = 0;
    } else if (this.phase === 'harvest' || this.phase === 'linger') {
      const remaining = this.targets.some((t) => !t.done);
      const maxDwell = backlog ? clamp(11 - backlog * 0.7, 2.2, 11) / this.userPace : Infinity;
      if (backlog && this.phaseT > 1.1 && (!remaining || this.phaseT > maxDwell)) this.nextPage();
      else if (!remaining && !backlog) {
        if (this.phase === 'harvest') {
          this.phase = 'linger';
          this.phaseT = 0;
        } else if (this.phaseT > (this.crawlDone ? 2.6 : 1.4)) {
          // nothing new to show: keep the spiders feeding on this page
          this.pickTargets(this.agents.length + 1);
          this.phaseT = 0;
        }
      }
    } else if (this.phase === 'hero' && !this.targets.some((t) => !t.done) && this.phaseT > 3) {
      for (const t of this.targets) t.el.classList.remove('is-harvested', 'is-queued');
      this.targets = [];
      this.pickTargets(5, true);
      this.phaseT = 0;
    }

    // ---- camera
    const working = this.agents.filter((a) => a.state === 'seek' || a.state === 'grab');
    if (this.time > this.userScrollUntil && this.sheet && this.phase !== 'hero') {
      const lead = working.length ? working.reduce((s, a) => s + a.sp.pos.y, 0) / working.length : null;
      if (lead !== null) this.camTarget = clamp(lead - this.viewH * 0.48, 0, this.maxCam);
    }
    const prevCam = this.camY;
    this.camY = damp(this.camY, this.camTarget, 2.6, dt);
    if (this.sheet && Math.abs(this.camY - prevCam) > 0.01) this.sheet.style.transform = `translate3d(0,${-this.camY.toFixed(2)}px,0)`;

    // ---- agents
    const spiders = this.agents.map((a) => a.sp);
    const bounds = this.sheetBounds();
    for (const a of this.agents) this.updateAgent(a, dt, bounds);
    for (const a of this.agents) {
      a.sp.update(dt, spiders);
      // keep inside the stage horizontally
      a.sp.pos.x = clamp(a.sp.pos.x, 12, this.rect.width - 12);
      const tail = a.sp.spinneret;
      const last = a.trail[a.trail.length - 1];
      if (!a.sp.airborne && (!last || Math.hypot(tail.x - last.x, tail.y - last.y) > 9)) a.trail.push({ x: tail.x, y: tail.y, t: now });
      while (a.trail.length && now - a.trail[0].t > 2.6) a.trail.shift();
    }

    // ---- ambient corruption, like a page being eaten
    if (!this.reduced && this.sheet && this.phase !== 'hero' && now > this.nextGlitch) {
      this.nextGlitch = now + rand(0.5, 1.5) / this.pace;
      this.ambientGlitch();
    }

    this.updateFlyers(dt);
    this.updateShards(dt);
    if (this.scan) {
      this.scan.t += dt;
      if (this.scan.t > this.scan.dur) this.scan = null;
    }
    this.strands = this.strands.filter((s) => !s.dying || now - s.dying < 0.7);
  }

  private updateAgent(a: Agent, dt: number, bounds: { l: number; r: number }) {
    const sp = a.sp;
    a.t += dt;
    switch (a.state) {
      case 'drop': {
        const d = a.drop!;
        if (a.t < 0) return;
        const k = clamp(a.t / d.dur, 0, 1);
        const e = easeOutCubic(k);
        sp.pos.y = d.from + (d.to - d.from) * e;
        sp.vel = v(0, 0);
        sp.target = null;
        sp.airborne = 1 - clamp((k - 0.75) / 0.25, 0, 1);
        if (k >= 1) {
          sp.airborne = 0;
          sp.replant();
          a.drop = null;
          a.state = 'wander';
          a.t = 0;
          this.o.onRipple(this.rect.left + sp.pos.x, this.rect.top + sp.pos.y - this.camY, 0.5);
        }
        return;
      }
      case 'wander':
      case 'poke': {
        const t = this.phase === 'harvest' || this.phase === 'linger' || this.phase === 'hero' ? this.claimTarget(a) : null;
        if (t) {
          a.target = t;
          a.state = 'seek';
          a.t = 0;
          break;
        }
        if (a.state === 'poke') {
          sp.target = a.goal;
          if (dist(sp.pos, a.goal) < 10 || a.t > 3) a.state = 'wander';
          break;
        }
        // in the hero, the first spider is curious about the cursor
        const p = this.pointer;
        if (this.phase === 'hero' && a === this.agents[0] && p && this.time - p.at < 2.5) {
          const dx = sp.pos.x - p.x;
          const dy = sp.pos.y - p.y;
          const d = Math.hypot(dx, dy) || 1;
          sp.target = v(p.x + (dx / d) * 70, p.y + (dy / d) * 70);
          sp.face = v(p.x, p.y);
          break;
        }
        if (a.t > a.nextWander || !sp.target) {
          a.nextWander = a.t + rand(1.6, 3.4);
          a.goal = v(rand(bounds.l + 40, bounds.r - 40), this.camY + rand(this.viewH * 0.22, this.viewH * 0.85));
          sp.face = null;
        }
        sp.target = a.goal;
        break;
      }
      case 'seek': {
        const t = a.target!;
        if (!t.el.isConnected) {
          a.state = 'wander';
          break;
        }
        const c = v(t.x + Math.min(t.w, 140) / 2, t.y + t.h / 2);
        const dx = c.x - sp.pos.x;
        const dy = c.y - sp.pos.y;
        const d = Math.hypot(dx, dy) || 1;
        const reach = 20 * sp.s;
        sp.target = v(c.x - (dx / d) * reach, c.y - (dy / d) * reach);
        sp.face = c;
        if (d < reach + 9 || (a.t > 7 && d < 120)) {
          a.state = 'grab';
          a.t = 0;
          a.grabbedAt = c;
          sp.target = null;
          sp.lungeTarget = 1;
        } else if (a.t > 12) {
          t.claimed = false;
          t.el.classList.remove('is-targeted');
          a.state = 'wander';
        }
        break;
      }
      case 'grab': {
        const t = a.target!;
        const grabT = 0.42 / Math.sqrt(this.pace);
        if (a.t > 0.1 && !t.el.classList.contains('is-grabbed')) {
          t.el.classList.add('is-grabbed');
          if (!this.reduced) scramble(t.el, 380);
          this.burst(t);
        }
        if (a.t > 0.2) sp.lungeTarget = 0;
        if (a.t > grabT) this.tear(a, t);
        break;
      }
    }
  }

  private burst(t: Target) {
    const sx = this.rect.left + t.x + Math.min(t.w, 140) / 2;
    const sy = this.rect.top + t.y - this.camY + t.h / 2;
    const color = t.kind === 'internal' && !t.isNew ? KIND_COLOR.seen : KIND_COLOR[t.kind];
    const n = this.reduced ? 0 : 9;
    const text = t.text.replace(/\s/g, '') || GLYPHS;
    for (let i = 0; i < n; i++) {
      const ang = rand(0, TAU);
      const sp = rand(60, 240);
      this.shards.push({
        x: sx + rand(-t.w / 3, t.w / 3),
        y: sy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 80,
        life: 0,
        max: rand(0.5, 1.0),
        ch: Math.random() < 0.6 ? text[(Math.random() * text.length) | 0] : pick(GLYPHS.split('')),
        color,
        rot: rand(-1, 1),
        vr: rand(-8, 8),
      });
    }
    this.o.onRipple(sx, sy, t.kind === 'internal' && t.isNew ? 0.55 : 0.3);
  }

  private tear(a: Agent, t: Target) {
    t.done = true;
    t.el.classList.remove('is-grabbed', 'is-targeted', 'is-queued');
    t.el.classList.add('is-harvested');
    this.measure(t);
    const c = v(t.x + Math.min(t.w, 140) / 2, t.y + t.h / 2);
    if (a.anchor) this.strands.push({ a: a.anchor, b: c, born: this.time, color: a.sp.palette.leg, dying: 0 });
    a.anchor = c;
    a.target = null;
    a.state = 'wander';
    a.t = 0;
    a.nextWander = 0.4;
    this.measureTargets();

    if (this.phase === 'hero') {
      setTimeout(() => t.el.classList.remove('is-harvested'), 2400);
      return;
    }
    if (t.el.dataset.fake) {
      // firewall glyph: bitten to pieces, nothing to send to the feed
      this.burst(t);
      t.el.classList.add('is-chewed');
      return;
    }
    this.launchFlyer(t);
  }

  private launchFlyer(t: Target) {
    const dest = this.o.feedTarget();
    const harvest: Harvest = { url: t.url, text: t.text, kind: t.kind, isNew: t.isNew, pageUrl: this.current?.url ?? '' };
    if (!dest || this.reduced) {
      this.o.onHarvest(harvest);
      return;
    }
    const el = document.createElement('div');
    const color = t.kind === 'internal' && !t.isNew ? KIND_COLOR.seen : KIND_COLOR[t.kind];
    el.className = `flyer k-${t.kind}${t.isNew ? ' is-new' : ''}`;
    el.style.setProperty('--c', color);
    el.textContent = t.text.length > 46 ? t.text.slice(0, 45) + '…' : t.text || t.url;
    document.body.appendChild(el);
    const sx = this.rect.left + t.x;
    const sy = this.rect.top + t.y - this.camY;
    const p0 = v(sx, sy);
    const p3 = v(dest.left + 14, dest.top + 10);
    const lift = rand(120, 220);
    const p1 = v(p0.x + rand(-40, 60), p0.y - lift);
    const p2 = v(p3.x - rand(120, 220), p3.y - rand(40, 140));
    this.flyers.push({
      el,
      p: [p0, p1, p2, p3],
      t: 0,
      dur: rand(0.85, 1.15) / Math.sqrt(this.pace),
      spin: rand(-0.35, 0.35),
      color,
      origin: v(t.x + Math.min(t.w, 140) / 2, t.y + t.h / 2),
      onLand: () => this.o.onHarvest(harvest),
    });
  }

  private updateFlyers(dt: number) {
    for (const f of this.flyers) {
      f.t += dt / f.dur;
      const k = easeInOutCubic(Math.min(1, f.t));
      const p = cubicBezier(f.p[0], f.p[1], f.p[2], f.p[3], k);
      const sc = 1 + Math.sin(Math.min(1, f.t) * Math.PI) * 0.18 - k * 0.25;
      const rot = Math.sin(k * Math.PI) * f.spin;
      f.el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) rotate(${rot.toFixed(3)}rad) scale(${sc.toFixed(3)})`;
      f.el.style.opacity = String(f.t > 0.85 ? 1 - (f.t - 0.85) / 0.15 : 1);
      if (f.t >= 1) {
        f.el.remove();
        f.onLand();
      }
    }
    this.flyers = this.flyers.filter((f) => f.t < 1);
  }

  private updateShards(dt: number) {
    for (const s of this.shards) {
      s.life += dt;
      s.vy += 420 * dt;
      s.vx *= Math.exp(-2 * dt);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vr * dt;
    }
    this.shards = this.shards.filter((s) => s.life < s.max);
  }

  private ambientGlitch() {
    const sheet = this.sheet!;
    const blocks = sheet.querySelectorAll<HTMLElement>('.b');
    if (!blocks.length) return;
    // corrupt a block close to one of the spiders
    const a = pick(this.agents);
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (let i = 0; i < 14; i++) {
      const b = blocks[(Math.random() * blocks.length) | 0];
      const y = b.offsetTop + b.offsetHeight / 2;
      const d = Math.abs(y - a.sp.pos.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) return;
    const cls = pick(['glx-split', 'glx-slice', 'glx-font', 'glx-font-serif']);
    best.classList.add(cls);
    setTimeout(() => best!.classList.remove(cls), cls.startsWith('glx-font') ? rand(500, 900) : rand(220, 420));
  }

  // ---------------------------------------------------------------- draw
  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const r = this.rect;
    const ox = r.left;
    const oy = r.top - this.camY;

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();

    // scan beam on page enter
    if (this.scan) {
      const k = easeInOutCubic(this.scan.t / this.scan.dur);
      const y = r.top + k * r.height;
      const g = ctx.createLinearGradient(0, y - 90, 0, y + 2);
      g.addColorStop(0, 'rgba(94,231,255,0)');
      g.addColorStop(1, 'rgba(94,231,255,0.16)');
      ctx.fillStyle = g;
      ctx.fillRect(r.left, y - 90, r.width, 92);
      ctx.fillStyle = 'rgba(160,245,255,0.85)';
      ctx.fillRect(r.left, y, r.width, 1);
    }

    // web strands between harvested links
    for (const s of this.strands) {
      const age = this.time - s.born;
      const fadeIn = clamp(age / 0.35, 0, 1);
      const fade = s.dying ? 1 - clamp((this.time - s.dying) / 0.7, 0, 1) : 1;
      const a = s.a;
      const b = v(a.x + (s.b.x - a.x) * fadeIn, a.y + (s.b.y - a.y) * fadeIn);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const L = dist(a, b);
      const nx = -(b.y - a.y) / (L || 1);
      const ny = (b.x - a.x) / (L || 1);
      const sag = L * 0.08 * Math.sin(this.time * 1.8 + a.x * 0.01);
      ctx.strokeStyle = hexA(s.color, 0.32 * fade);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x + ox, a.y + oy);
      ctx.quadraticCurveTo(mx + nx * sag + ox, my + ny * sag + oy, b.x + ox, b.y + oy);
      ctx.stroke();
      // a dew-drop of light travelling along the thread
      const tt = (this.time * 0.6 + a.x * 0.003) % 1;
      const qx = (1 - tt) * (1 - tt) * a.x + 2 * (1 - tt) * tt * (mx + nx * sag) + tt * tt * b.x;
      const qy = (1 - tt) * (1 - tt) * a.y + 2 * (1 - tt) * tt * (my + ny * sag) + tt * tt * b.y;
      ctx.fillStyle = hexA(s.color, 0.8 * fade);
      ctx.beginPath();
      ctx.arc(qx + ox, qy + oy, 1.4, 0, TAU);
      ctx.fill();
    }

    for (const a of this.agents) {
      const sp = a.sp;
      // dragline: fading silk behind each spider
      const tr = a.trail;
      if (tr.length > 1) {
        ctx.lineWidth = 1;
        for (let i = 1; i < tr.length; i++) {
          const al = clamp(1 - (this.time - tr[i].t) / 2.6, 0, 1) * 0.28;
          ctx.strokeStyle = hexA(sp.palette.leg, al);
          ctx.beginPath();
          ctx.moveTo(tr[i - 1].x + ox, tr[i - 1].y + oy);
          ctx.lineTo(tr[i].x + ox, tr[i].y + oy);
          ctx.stroke();
        }
        const tail = sp.spinneret;
        const lst = tr[tr.length - 1];
        ctx.strokeStyle = hexA(sp.palette.leg, 0.28);
        ctx.beginPath();
        ctx.moveTo(lst.x + ox, lst.y + oy);
        ctx.lineTo(tail.x + ox, tail.y + oy);
        ctx.stroke();
      }
      // silk while dropping in from the top
      if (a.state === 'drop' && a.t > 0) {
        ctx.strokeStyle = hexA(sp.palette.body, 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sp.pos.x + ox, r.top);
        ctx.lineTo(sp.pos.x + ox, sp.pos.y + oy);
        ctx.stroke();
      }
      // targeting reticle + bite thread
      if ((a.state === 'seek' || a.state === 'grab') && a.target) {
        const t = a.target;
        const c = v(t.x + Math.min(t.w, 140) / 2 + ox, t.y + t.h / 2 + oy);
        const h = sp.head;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = -this.time * 30;
        ctx.strokeStyle = hexA(sp.palette.leg, a.state === 'grab' ? 0.9 : 0.35);
        ctx.lineWidth = a.state === 'grab' ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(h.x + ox, h.y + oy);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    for (const a of this.agents) if (a.t >= 0 || a.state !== 'drop') a.sp.draw(ctx, ox, oy);
    ctx.restore();

    // threads pulling torn links to the panel
    for (const f of this.flyers) {
      if (f.t > 0.55) continue;
      const k = easeInOutCubic(Math.min(1, f.t));
      const p = cubicBezier(f.p[0], f.p[1], f.p[2], f.p[3], k);
      const o = v(f.origin.x + ox, f.origin.y + oy);
      const al = 0.7 * (1 - f.t / 0.55);
      ctx.strokeStyle = hexA(f.color, al);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.quadraticCurveTo((o.x + p.x) / 2, Math.max(o.y, p.y) + 30, p.x + 8, p.y + 10);
      ctx.stroke();
    }

    // glyph shards
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of this.shards) {
      ctx.save();
      ctx.globalAlpha = 1 - s.life / s.max;
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.fillStyle = s.color;
      ctx.fillText(s.ch, 0, 0);
      ctx.restore();
    }
  }
}

// ------------------------------------------------------------------ helpers
function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

const TAG_MAP: Record<string, string> = {
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4',
  p: 'p', li: 'li', blockquote: 'blockquote', pre: 'pre', dt: 'dt', dd: 'dd',
  figcaption: 'p', caption: 'p', summary: 'p',
};

function fmtBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderBlocks(sheet: HTMLElement, blocks: Block[], links: Map<string, boolean>) {
  let k = 0;
  for (const b of blocks) {
    const tag = TAG_MAP[b.tag] ?? 'p';
    const node = el((tag === 'li' ? 'div' : tag) as keyof HTMLElementTagNameMap, `b b-${tag}`);
    for (const s of b.segments) {
      if (s.href) {
        const a = el('a', `lk k-${s.kind ?? 'external'}`, s.text);
        a.href = s.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        a.dataset.k = s.kind ?? 'external';
        a.dataset.url = s.href;
        a.dataset.i = String(k++);
        if (s.kind === 'internal' && links.get(s.href)) a.classList.add('is-new');
        node.appendChild(a);
      } else if (s.style) {
        node.appendChild(el(s.style === 'code' ? 'code' : s.style === 'em' ? 'em' : 'strong', undefined, s.text));
      } else node.appendChild(document.createTextNode(s.text));
    }
    sheet.appendChild(node);
  }
}

export function buildSheet(p: PageEvent): HTMLElement {
  const sheet = el('article', 'sheet');
  const meta = el('div', 'sheet-meta');
  const ok = p.status >= 200 && p.status < 300;
  meta.append(
    el('span', `m-status ${ok ? 'ok' : p.status >= 400 ? 'bad' : 'warn'}`, `GET ${p.status}`),
    el('span', 'm-item', `${p.timeMs} ms`),
    el('span', 'm-item', fmtBytes(p.bytes)),
    el('span', 'm-item', `depth ${p.depth}`),
    el('span', 'm-item', `${p.linkCounts?.internal ?? 0} int · ${p.linkCounts?.external ?? 0} ext`),
    el('span', 'm-item', `${p.words ?? 0} words`),
  );
  if (p.archived) {
    const d = p.archived;
    meta.prepend(el('span', 'm-archive', `⟲ archived ${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`));
  }
  if (p.status === 0) meta.firstElementChild!.textContent = 'GET ERR';
  sheet.appendChild(meta);
  if (p.status === 0 || p.status >= 400) return buildBlocked(sheet, p);
  sheet.appendChild(el('div', 'sheet-url', p.finalUrl ?? p.url));
  const blocks = p.snapshot.slice();
  if (!blocks.length || blocks[0].tag !== 'h1') {
    blocks.unshift({ tag: 'h1', segments: [{ text: p.title || p.h1 || new URL(p.url).pathname }] });
  }
  if (p.description && !blocks.slice(0, 4).some((b) => b.segments.map((s) => s.text).join('') === p.description)) {
    blocks.splice(1, 0, { tag: 'blockquote', segments: [{ text: p.description }] });
  }
  if (!p.snapshot.length) blocks.push({ tag: 'p', segments: [{ text: 'This response had no readable HTML body.' }] });
  renderBlocks(sheet, blocks, new Map(p.links.map((l) => [l.url, l.isNew])));
  return sheet;
}

/** A refused page becomes a firewall the spiders can chew on. */
function buildBlocked(sheet: HTMLElement, p: PageEvent): HTMLElement {
  sheet.classList.add('blocked');
  sheet.appendChild(el('div', 'sheet-url', p.finalUrl ?? p.url));
  const code = p.status ? String(p.status) : 'ERR';
  const wall = el('div', 'b firewall');
  let i = 0;
  const glyph = (txt: string, cls: string) => {
    const a = el('a', `lk k-external fw-glyph ${cls}`, txt);
    a.dataset.k = 'external';
    a.dataset.url = `#fw-${i++}`;
    a.dataset.fake = '1';
    a.setAttribute('role', 'presentation');
    return a;
  };
  const digits = el('div', 'fw-code');
  for (const ch of code) digits.appendChild(glyph(ch, 'fw-digit'));
  wall.appendChild(digits);
  const bricks = el('div', 'fw-bricks');
  const words = p.status === 404 || p.status === 410
    ? ['NOT', 'FOUND', 'DEAD', 'END', 'NO', 'THREAD', 'HERE', 'LOST']
    : p.status === 0
      ? ['NO', 'ROUTE', 'TIMEOUT', 'SILENCE', 'VOID', 'OFFLINE']
      : ['ACCESS', 'DENIED', 'BOT', 'WALL', 'SHIELD', 'CHALLENGE', 'FORBIDDEN', 'GUARD'];
  for (const w of words) bricks.appendChild(glyph(w, 'fw-brick'));
  wall.appendChild(bricks);
  sheet.appendChild(wall);

  const server = (p.server ?? '').toLowerCase();
  const guard = /cloudflare/.test(server) ? 'Cloudflare' : /akamai/.test(server) ? 'Akamai' : /sucuri/.test(server) ? 'Sucuri' : /imperva|incapsula/.test(server) ? 'Imperva' : '';
  const title =
    p.status === 404 ? 'This thread leads nowhere' :
    p.status === 0 ? 'The web went silent' :
    p.status === 429 ? 'Too many spiders, said the server' :
    'The site raised its shield';
  sheet.appendChild(el('h1', 'b b-h1', title));
  const why =
    p.status === 0 ? `The request failed: ${p.error ?? 'no response'}.` :
    p.status === 404 ? 'The server says this page does not exist. Arachne still reads the error page for navigation links and tries the home page.' :
    `${guard ? `Guarded by ${guard}. ` : ''}This site tells crawlers to keep out (HTTP ${p.status}). Arachne respects that and does not try to sneak past bot protection.`;
  sheet.appendChild(el('p', 'b b-p', why));
  if (p.archiveMissed) {
    sheet.appendChild(el('p', 'b b-p fw-hint', 'Time-travel tried too: the Internet Archive has no usable copy of this page right now. Try another site, or the built-in sandbox from the home screen.'));
  } else if (p.status !== 404) {
    sheet.appendChild(el('p', 'b b-p fw-hint', 'Tip: with time-travel on (Settings), the spiders ask the Internet Archive for a public, older copy of a site that refuses them. Or try the built-in sandbox from the home screen.'));
  }
  if (p.snapshot.length) {
    sheet.appendChild(el('h2', 'b b-h2', 'Found on the error page'));
    renderBlocks(sheet, p.snapshot, new Map(p.links.map((l) => [l.url, l.isNew])));
  }
  return sheet;
}

const DEMOS: [string, string][] = [
  ['sandbox — the built-in Spider Atlas, always works', 'sandbox'],
  ['books.toscrape.com', 'https://books.toscrape.com/'],
  ['quotes.toscrape.com', 'https://quotes.toscrape.com/'],
  ['en.wikipedia.org/wiki/Spider', 'https://en.wikipedia.org/wiki/Spider'],
  ['developer.mozilla.org', 'https://developer.mozilla.org/en-US/docs/Web/HTML'],
  ['scrapethissite.com', 'https://www.scrapethissite.com/pages/'],
];

function buildHero(): HTMLElement {
  const sheet = el('article', 'sheet hero');
  const kicker = el('div', 'hero-kicker', 'ARACHNE · VISUAL WEB CRAWLER');
  const h1 = el('h1', 'b b-h1 hero-title');
  h1.append('Crawl the web. ', el('em', undefined, 'Watch it crawl.'));
  const lead = el(
    'p',
    'b b-p hero-lead',
    'Every crawler worker is a living spider. It walks the page it is reading, bites every link it discovers, tears it out of the document and spins your site map in real time. Paste a URL above and release them.',
  );
  sheet.append(kicker, h1, lead);
  sheet.appendChild(el('h2', 'b b-h2', 'Try a playground'));
  for (const [label, url] of DEMOS) {
    const row = el('div', 'b b-li');
    const a = el('a', 'lk k-internal is-new', label);
    a.href = url;
    a.dataset.k = 'internal';
    a.dataset.url = url;
    a.dataset.demo = url;
    row.append(a, ` — click to release the spiders here`);
    sheet.appendChild(row);
  }
  sheet.appendChild(el('h2', 'b b-h2', 'Under the silk'));
  const feats = [
    ['Concurrent & polite', 'worker pool, per-host rate limiting, robots.txt + crawl-delay, retry with back-off'],
    ['Smart discovery', 'sitemap.xml seeding, URL normalisation, tracking-param stripping, canonical awareness'],
    ['SEO & health audit', 'broken links, redirects, slow pages, missing titles / descriptions / h1 / alt text'],
    ['Live site graph', 'force-directed map of every page and link, coloured by status'],
    ['Export', 'JSON, CSV and a ready-to-submit sitemap.xml'],
  ];
  for (const [t, d] of feats) {
    const row = el('div', 'b b-li');
    row.append(el('strong', undefined, t), ` — ${d}`);
    sheet.appendChild(row);
  }
  const tip = el('p', 'b b-p hero-tip');
  tip.append('Tip: click anywhere on this page and the nearest spider will run to it. Scroll to take the camera.');
  sheet.appendChild(tip);
  return sheet;
}

function buildWaiting(url: string): HTMLElement {
  const sheet = el('article', 'sheet waiting');
  sheet.appendChild(el('div', 'sheet-url', url));
  sheet.appendChild(el('h1', 'b b-h1', 'Spinning up…'));
  for (const line of ['resolving host & checking it is public', 'reading robots.txt rules', 'looking for sitemap.xml', 'fetching the first page']) {
    const row = el('div', 'b b-li wait-line');
    row.textContent = line;
    sheet.appendChild(row);
  }
  for (let i = 0; i < 7; i++) {
    const sk = el('div', 'skeleton');
    sk.style.width = `${rand(55, 100)}%`;
    sheet.appendChild(sk);
  }
  return sheet;
}
