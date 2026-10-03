import { clamp, damp, TAU } from './math';
import type { PageRecord } from './types';

interface GNode {
  id: number;
  url: string;
  title: string;
  status: number;
  depth: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  inl: number;
  born: number;
}

const statusColor = (s: number) => (s >= 200 && s < 300 ? '#5ee7ff' : s >= 300 && s < 400 ? '#ffb84d' : '#ff4d6d');

/** Live force-directed map of the crawled site. */
export class SiteGraph {
  private ctx: CanvasRenderingContext2D;
  private nodes: GNode[] = [];
  private byId = new Map<number, GNode>();
  private byUrl = new Map<string, GNode>();
  private tree: [GNode, GNode][] = [];
  private cross: [GNode, GNode][] = [];
  private crossKeys = new Set<string>();
  private pending = new Map<string, number[]>();
  private pendingSize = 0;
  private cam = { x: 0, y: 0, z: 1 };
  private userCamUntil = 0;
  private alpha = 1;
  private time = 0;
  private hover: GNode | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  visible = false;
  onSelect: (url: string) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private tip: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.bind();
  }

  clear() {
    this.nodes = [];
    this.byId.clear();
    this.byUrl.clear();
    this.tree = [];
    this.cross = [];
    this.crossKeys.clear();
    this.pending.clear();
    this.pendingSize = 0;
    this.cam = { x: 0, y: 0, z: 1 };
    this.alpha = 1;
  }

  get size() {
    return this.nodes.length;
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  private addCross(a: GNode, b: GNode) {
    if (a === b) return;
    const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (this.crossKeys.has(k) || this.cross.length > 6000) return;
    this.crossKeys.add(k);
    this.cross.push([a, b]);
  }

  add(p: PageRecord, internalLinks: string[]) {
    if (this.byUrl.has(p.url)) return;
    const parent = p.from !== null ? this.byId.get(p.from) : undefined;
    const ang = Math.random() * TAU;
    const n: GNode = {
      id: p.id,
      url: p.url,
      title: p.title,
      status: p.status,
      depth: p.depth,
      x: (parent?.x ?? 0) + Math.cos(ang) * 20,
      y: (parent?.y ?? 0) + Math.sin(ang) * 20,
      vx: 0,
      vy: 0,
      inl: 0,
      born: this.time,
    };
    this.nodes.push(n);
    this.byId.set(p.id, n);
    this.byUrl.set(p.url, n);
    if (p.finalUrl && p.finalUrl !== p.url) this.byUrl.set(p.finalUrl, n);
    if (parent) {
      this.tree.push([parent, n]);
      parent.inl++;
    }
    for (const u of [p.url, p.finalUrl]) {
      const waiting = u ? this.pending.get(u) : undefined;
      if (!waiting) continue;
      for (const id of waiting) {
        const src = this.byId.get(id);
        if (src && src !== parent) this.addCross(src, n);
        n.inl++;
      }
      this.pending.delete(u!);
    }
    for (const u of internalLinks) {
      const t = this.byUrl.get(u);
      if (t) {
        if (t !== parent) this.addCross(n, t);
        t.inl++;
      } else if (this.pendingSize < 250_000) {
        const arr = this.pending.get(u);
        if (arr) arr.push(n.id);
        else this.pending.set(u, [n.id]);
        this.pendingSize++;
      }
    }
    this.alpha = Math.max(this.alpha, 0.6);
  }

  private bind() {
    const c = this.canvas;
    const toWorld = (sx: number, sy: number) => ({
      x: (sx - this.w / 2) / this.cam.z + this.cam.x,
      y: (sy - this.h / 2) / this.cam.z + this.cam.y,
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const before = toWorld(sx, sy);
        this.cam.z = clamp(this.cam.z * Math.exp(-e.deltaY * 0.0015), 0.08, 6);
        const after = toWorld(sx, sy);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
        this.userCamUntil = this.time + 8;
      },
      { passive: false },
    );
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        this.cam.x = this.drag.cx - dx / this.cam.z;
        this.cam.y = this.drag.cy - dy / this.cam.z;
        this.userCamUntil = this.time + 8;
      }
      const w = toWorld(e.clientX - r.left, e.clientY - r.top);
      let best: GNode | null = null;
      let bd = (14 / this.cam.z) ** 2;
      for (const n of this.nodes) {
        const d = (n.x - w.x) ** 2 + (n.y - w.y) ** 2;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      this.hover = best;
      if (best) {
        this.tip.hidden = false;
        this.tip.replaceChildren();
        const t = document.createElement('strong');
        t.textContent = best.title || '(untitled)';
        const u = document.createElement('span');
        u.textContent = best.url;
        const m = document.createElement('em');
        m.textContent = `${best.status || 'ERR'} · depth ${best.depth} · ${best.inl} inlinks`;
        this.tip.append(t, u, m);
        this.tip.style.transform = `translate(${Math.min(e.clientX - r.left + 14, this.w - 230)}px, ${e.clientY - r.top + 14}px)`;
      } else this.tip.hidden = true;
    });
    c.addEventListener('pointerup', () => {
      if (this.drag && !this.drag.moved && this.hover) this.onSelect(this.hover.url);
      this.drag = null;
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.hidden = true;
    });
    c.addEventListener('dblclick', () => (this.userCamUntil = 0));
  }

  /** physics step: grid-accelerated repulsion, springs, gentle gravity */
  step(dt: number) {
    this.time += dt;
    const N = this.nodes.length;
    if (!N) return;
    this.alpha = Math.max(0.04, this.alpha * Math.exp(-0.35 * dt));
    const a = this.alpha;
    const cell = 70;
    const grid = new Map<number, GNode[]>();
    const key = (x: number, y: number) => ((x + 4096) << 13) | (y + 4096);
    for (const n of this.nodes) {
      const k = key(Math.floor(n.x / cell), Math.floor(n.y / cell));
      const b = grid.get(k);
      if (b) b.push(n);
      else grid.set(k, [n]);
    }
    const rep = 900 * a;
    for (const n of this.nodes) {
      const cx = Math.floor(n.x / cell);
      const cy = Math.floor(n.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const b = grid.get(key(gx, gy));
          if (!b) continue;
          for (const m of b) {
            if (m === n) continue;
            let dx = n.x - m.x;
            let dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 0.25;
            }
            if (d2 > cell * cell) continue;
            const f = rep / d2;
            n.vx += dx * f * dt;
            n.vy += dy * f * dt;
          }
        }
      }
      n.vx -= n.x * 0.35 * a * dt;
      n.vy -= n.y * 0.35 * a * dt;
    }
    const spring = (s: GNode, t: GNode, rest: number, k: number) => {
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - rest) * k * a;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      s.vx += fx * dt;
      s.vy += fy * dt;
      t.vx -= fx * dt;
      t.vy -= fy * dt;
    };
    for (const [s, t] of this.tree) spring(s, t, 30, 14);
    if (this.cross.length < 4000) for (const [s, t] of this.cross) spring(s, t, 60, 0.6);
    const damping = Math.exp(-4 * dt);
    for (const n of this.nodes) {
      n.vx *= damping;
      n.vy *= damping;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > 600) {
        n.vx *= 600 / sp;
        n.vy *= 600 / sp;
      }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
    }

    // auto-fit camera unless the user is driving
    if (this.time > this.userCamUntil) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      const z = clamp(Math.min(this.w / (maxX - minX + 120), this.h / (maxY - minY + 120)), 0.1, 2.4);
      this.cam.x = damp(this.cam.x, (minX + maxX) / 2, 3, dt);
      this.cam.y = damp(this.cam.y, (minY + maxY) / 2, 3, dt);
      this.cam.z = damp(this.cam.z, z, 3, dt);
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.nodes.length) {
      ctx.fillStyle = 'rgba(200,195,255,0.45)';
      ctx.font = '13px "Space Grotesk", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('The site map spins itself here as pages are crawled', this.w / 2, this.h / 2);
      return;
    }
    const z = this.cam.z;
    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (this.w / 2 - this.cam.x * z), this.dpr * (this.h / 2 - this.cam.y * z));
    const hv = this.hover;

    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = 'rgba(164,139,255,0.07)';
    ctx.beginPath();
    for (const [s, t] of this.cross) {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(94,231,255,0.28)';
    ctx.lineWidth = 1.2 / z;
    ctx.beginPath();
    for (const [s, t] of this.tree) {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();
    if (hv) {
      ctx.strokeStyle = 'rgba(255,79,176,0.75)';
      ctx.lineWidth = 1.4 / z;
      ctx.beginPath();
      for (const [s, t] of [...this.tree, ...this.cross]) {
        if (s !== hv && t !== hv) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
      }
      ctx.stroke();
    }

    for (const n of this.nodes) {
      const r = (2.6 + Math.sqrt(n.inl) * 0.9 + (n.depth === 0 ? 3 : 0)) / Math.sqrt(z);
      const age = this.time - n.born;
      const col = statusColor(n.status);
      if (age < 1.2) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 1 - age / 1.2;
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + age * 26, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n === hv ? r * 1.7 : r, 0, TAU);
      ctx.fill();
      if (n.depth === 0) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 / z, 0, TAU);
        ctx.stroke();
      }
    }
  }
}
