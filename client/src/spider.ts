import { V, v, clamp, damp, dampAngle, dist, easeInOutSine, lerp, noise1, smoothstep, TAU } from './math';

export interface SpiderPalette {
  leg: string; // primary neon colour
  joint: string; // joint dots
  body: string; // body wireframe
  glow: string; // rgba for additive glow
}

export const PALETTES: SpiderPalette[] = [
  { leg: '#5ee7ff', joint: '#ff3d9a', body: '#a9f4ff', glow: 'rgba(94,231,255,0.20)' },
  { leg: '#ff4fb0', joint: '#5ee7ff', body: '#ffc2e4', glow: 'rgba(255,79,176,0.20)' },
  { leg: '#b9ff5c', joint: '#8b5cff', body: '#e4ffc2', glow: 'rgba(185,255,92,0.18)' },
  { leg: '#ffb84d', joint: '#ff3d9a', body: '#ffe1b0', glow: 'rgba(255,184,77,0.18)' },
];

interface Leg {
  side: 1 | -1;
  idx: number;
  group: 0 | 1;
  hipA: number;
  hipR: number;
  restA: number;
  restR: number;
  l1: number;
  l2: number;
  foot: V;
  from: V;
  to: V;
  t: number;
  dur: number;
  stepping: boolean;
  lift: number;
}

// Front-to-back leg layout (angle from forward axis, radians)
const REST_A = [0.6, 1.22, 1.92, 2.52];
const REST_R = [52, 45, 45, 54];
const HIP_A = [0.55, 1.2, 1.75, 2.25];

/**
 * A procedurally animated spider.
 *
 *  - Body is steered with a critically-damped "arrive" behaviour.
 *  - Each foot is planted in world space and only moves when it is too far
 *    from its ideal (velocity-predicted) rest position.
 *  - Legs step in two alternating tetrapod groups like a real spider,
 *    neighbouring legs never step together, and feet travel on an eased arc.
 *  - Legs are solved with analytic two-bone IK, knees always bending outward.
 */
export class Spider {
  pos: V;
  vel: V = v();
  heading = -Math.PI / 2;
  s: number;
  palette: SpiderPalette;
  legs: Leg[] = [];
  target: V | null = null;
  face: V | null = null;
  maxSpeed = 330;
  maxAccel = 2600;
  pace = 1;
  lunge = 0;
  lungeTarget = 0;
  bob = 0;
  time = Math.random() * 100;
  seed = Math.random() * 1000;
  /** while airborne the legs are tucked and not planted (silk drop) */
  airborne = 0;
  stepCount = 0;
  arrived = false;

  constructor(x: number, y: number, s = 1, palette = PALETTES[0]) {
    this.pos = v(x, y);
    this.s = s;
    this.palette = palette;
    for (const side of [1, -1] as const) {
      for (let i = 0; i < 4; i++) {
        const restR = REST_R[i] * s;
        const hipR = 7 * s;
        const reach = restR - hipR;
        const leg: Leg = {
          side,
          idx: i,
          group: ((i % 2 === 0) === (side === 1) ? 0 : 1) as 0 | 1,
          hipA: HIP_A[i],
          hipR,
          restA: REST_A[i],
          restR,
          l1: reach * 0.64,
          l2: reach * 0.7,
          foot: v(),
          from: v(),
          to: v(),
          t: 0,
          dur: 0.14,
          stepping: false,
          lift: 0,
        };
        leg.foot = this.restWorld(leg, v());
        this.legs.push(leg);
      }
    }
  }

  get fwd(): V {
    return v(Math.cos(this.heading), Math.sin(this.heading));
  }
  get right(): V {
    return v(-Math.sin(this.heading), Math.cos(this.heading));
  }

  local(f: number, sd: number, origin: V = this.pos): V {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    return v(origin.x + c * f - s * sd, origin.y + s * f + c * sd);
  }

  hipWorld(l: Leg) {
    return this.local(Math.cos(l.hipA) * l.hipR + 2 * this.s, Math.sin(l.hipA) * l.hipR * l.side);
  }

  restWorld(l: Leg, lead: V) {
    const p = this.local(Math.cos(l.restA) * l.restR, Math.sin(l.restA) * l.restR * l.side);
    return v(p.x + lead.x, p.y + lead.y);
  }

  /** Head (fangs) position, used to "bite" links. */
  get head(): V {
    return this.local((15 + this.lunge * 9) * this.s, 0);
  }
  get spinneret(): V {
    return this.local(-31 * this.s, 0);
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  /** shift spider and planted feet (used when the page scrolls under it) */
  translate(dx: number, dy: number) {
    this.pos.x += dx;
    this.pos.y += dy;
    if (this.target) {
      this.target.x += dx;
      this.target.y += dy;
    }
    for (const l of this.legs) {
      for (const p of [l.foot, l.from, l.to]) {
        p.x += dx;
        p.y += dy;
      }
    }
  }

  replant() {
    for (const l of this.legs) {
      l.foot = this.restWorld(l, v());
      l.stepping = false;
      l.lift = 0;
    }
  }

  update(dt: number, others: Spider[]) {
    this.time += dt;
    const s = this.s;
    const pace = this.pace;

    // ---- steering --------------------------------------------------------
    let ax = 0;
    let ay = 0;
    if (this.target) {
      const dx = this.target.x - this.pos.x;
      const dy = this.target.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      // Real spiders move in bursts: modulate cruise speed with smooth noise
      const burst = 0.78 + 0.32 * noise1(this.time * 1.7, this.seed);
      const want = this.maxSpeed * pace * burst * smoothstep(0, 110 * s, d);
      const dvx = (d > 0.01 ? (dx / d) * want : 0) - this.vel.x;
      const dvy = (d > 0.01 ? (dy / d) * want : 0) - this.vel.y;
      ax += dvx * 9;
      ay += dvy * 9;
      this.arrived = d < 5 * s && this.speed < 40;
    } else {
      ax -= this.vel.x * 8;
      ay -= this.vel.y * 8;
    }
    // separation from other spiders
    for (const o of others) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x;
      const dy = this.pos.y - o.pos.y;
      const d = Math.hypot(dx, dy);
      const r = 70 * s;
      if (d > 0.01 && d < r) {
        const k = ((r - d) / r) * 1600;
        ax += (dx / d) * k;
        ay += (dy / d) * k;
      }
    }
    const a = Math.hypot(ax, ay);
    const maxA = this.maxAccel * pace;
    if (a > maxA) {
      ax = (ax / a) * maxA;
      ay = (ay / a) * maxA;
    }
    if (this.airborne > 0) {
      ax = ay = 0;
    }
    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    // ---- heading ---------------------------------------------------------
    const spd = this.speed;
    if (spd > 22 * s) {
      this.heading = dampAngle(this.heading, Math.atan2(this.vel.y, this.vel.x), 7 * Math.min(1.6, pace), dt);
    } else if (this.face) {
      this.heading = dampAngle(this.heading, Math.atan2(this.face.y - this.pos.y, this.face.x - this.pos.x), 6, dt);
    }

    this.lunge = damp(this.lunge, this.lungeTarget, 22, dt);

    // ---- legs ------------------------------------------------------------
    if (this.airborne > 0) {
      for (const l of this.legs) {
        const tuck = 0.55 + 0.12 * Math.sin(this.time * 14 + l.idx * 1.3 + (l.side > 0 ? 0 : 1.7));
        const p = this.local(Math.cos(l.restA) * l.restR * tuck, Math.sin(l.restA) * l.restR * tuck * l.side);
        l.foot = p;
        l.stepping = false;
        l.lift = 1;
      }
      this.bob = damp(this.bob, 1, 10, dt);
      return;
    }

    const stepDur = clamp(0.17 - spd * 0.00022, 0.075, 0.17) / Math.sqrt(Math.max(0.5, pace));
    const lead = v(this.vel.x * stepDur * 1.15, this.vel.y * stepDur * 1.15);
    const settling = spd < 14 * s;

    const stepping = [false, false];
    let nStepping = 0;
    for (const l of this.legs) {
      if (l.stepping) {
        stepping[l.group] = true;
        nStepping++;
      }
    }

    // advance active steps (retargeting the landing spot keeps feet honest)
    for (const l of this.legs) {
      if (!l.stepping) continue;
      l.to = this.restWorld(l, lead);
      l.t += dt / l.dur;
      const k = easeInOutSine(clamp(l.t, 0, 1));
      l.foot = v(lerp(l.from.x, l.to.x, k), lerp(l.from.y, l.to.y, k));
      l.lift = Math.sin(Math.PI * clamp(l.t, 0, 1));
      if (l.t >= 1) {
        l.stepping = false;
        l.lift = 0;
        l.foot = { ...l.to };
        this.stepCount++;
      }
    }

    // pick legs that want to step, most-stretched first
    const wants = this.legs
      .filter((l) => !l.stepping)
      .map((l) => ({ l, d: dist(l.foot, this.restWorld(l, lead)) }))
      .sort((x, y) => y.d - x.d);

    for (const { l, d } of wants) {
      const threshold = (settling ? 0.16 : 0.4) * l.restR;
      const emergency = dist(l.foot, this.hipWorld(l)) > (l.l1 + l.l2) * 0.97;
      if (d < threshold && !emergency) continue;
      const other = l.group === 0 ? 1 : 0;
      const neighbourBusy = this.legs.some(
        (o) => o.stepping && o.side === l.side && Math.abs(o.idx - l.idx) === 1,
      );
      if (!emergency && (stepping[other] || neighbourBusy || nStepping >= 4)) continue;
      l.stepping = true;
      l.t = 0;
      l.dur = stepDur * (0.9 + Math.random() * 0.2);
      l.from = { ...l.foot };
      l.to = this.restWorld(l, lead);
      stepping[l.group] = true;
      nStepping++;
    }

    let lift = 0;
    for (const l of this.legs) lift += l.lift;
    this.bob = damp(this.bob, lift / 8, 14, dt);
  }

  /** Solve knee position with two-bone IK; knee bends away from body. */
  private knee(hip: V, foot: V, l: Leg): V {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const max = l.l1 + l.l2;
    const d = clamp(Math.hypot(dx, dy), Math.abs(l.l1 - l.l2) + 0.01, max * 0.999);
    const a = Math.atan2(dy, dx);
    const cosA = clamp((l.l1 * l.l1 + d * d - l.l2 * l.l2) / (2 * l.l1 * d), -1, 1);
    const alpha = Math.acos(cosA);
    const k1 = v(hip.x + Math.cos(a + alpha) * l.l1, hip.y + Math.sin(a + alpha) * l.l1);
    const k2 = v(hip.x + Math.cos(a - alpha) * l.l1, hip.y + Math.sin(a - alpha) * l.l1);
    // the knee that sits further from the body centre is the "outward" one
    return dist(k1, this.pos) > dist(k2, this.pos) ? k1 : k2;
  }

  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number, alpha = 1) {
    const s = this.s;
    const P = this.palette;
    const air = this.airborne;
    const lift = 3.5 * s * this.bob + air * 6 * s;

    const legs = this.legs.map((l) => {
      const hip = this.hipWorld(l);
      const foot = l.foot;
      const knee = this.knee(hip, foot, l);
      return { l, hip, foot, knee };
    });

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ---- shadow ----------------------------------------------------------
    const sh = 6 * s + air * 18 * s;
    ctx.strokeStyle = `rgba(0,0,0,${0.42 - air * 0.2})`;
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    for (const { hip, knee, foot } of legs) {
      ctx.moveTo(hip.x + ox + sh, hip.y + oy + sh * 1.4);
      ctx.lineTo(knee.x + ox + sh * 1.2, knee.y + oy + sh * 1.6);
      ctx.lineTo(foot.x + ox + sh * 0.3, foot.y + oy + sh * 0.5);
    }
    ctx.stroke();
    ctx.fillStyle = `rgba(0,0,0,${0.45 - air * 0.2})`;
    const ab = this.local(-18 * s, 0);
    ctx.beginPath();
    ctx.ellipse(ab.x + ox + sh, ab.y + oy + sh * 1.4, 15 * s, 11 * s, this.heading, 0, TAU);
    ctx.fill();

    // ---- legs --------------------------------------------------------------
    const kneeUp = (k: V, lf: number) => v(k.x + ox, k.y + oy - (4 * s + lf * 5 * s + lift));
    const footUp = (f: V, lf: number) => v(f.x + ox, f.y + oy - lf * 6 * s);
    const hipUp = (h: V) => v(h.x + ox, h.y + oy - lift);

    // additive glow pass
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = P.glow;
    ctx.lineWidth = 7 * s;
    ctx.beginPath();
    for (const { l, hip, knee, foot } of legs) {
      const h = hipUp(hip);
      const k = kneeUp(knee, l.lift);
      const f = footUp(foot, l.lift);
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(k.x, k.y);
      ctx.lineTo(f.x, f.y);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';

    for (const { l, hip, knee, foot } of legs) {
      const h = hipUp(hip);
      const k = kneeUp(knee, l.lift);
      const f = footUp(foot, l.lift);
      ctx.strokeStyle = P.leg;
      ctx.lineWidth = 2.3 * s;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(k.x, k.y);
      ctx.stroke();
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(k.x, k.y);
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      ctx.fillStyle = P.joint;
      ctx.beginPath();
      ctx.arc(k.x, k.y, 2.3 * s, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(f.x, f.y, (1.7 + l.lift * 0.6) * s, 0, TAU);
      ctx.fill();
    }

    // ---- abdomen -----------------------------------------------------------
    const breathe = 1 + Math.sin(this.time * 3.1) * 0.025;
    const abd = this.local(-18 * s, 0);
    const ax = abd.x + ox;
    const ay = abd.y + oy - lift * 1.15;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(this.heading + Math.sin(this.time * 9) * 0.04 * Math.min(1, this.speed / 200));
    ctx.fillStyle = 'rgba(6,5,14,0.88)';
    ctx.strokeStyle = P.body;
    ctx.lineWidth = 1.4 * s;
    ctx.beginPath();
    ctx.ellipse(0, 0, 14 * s * breathe, 10.5 * s * breathe, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // wireframe chevrons
    ctx.strokeStyle = P.leg;
    ctx.globalAlpha = alpha * 0.75;
    ctx.lineWidth = 1 * s;
    for (let i = 0; i < 3; i++) {
      const x = (4 - i * 5.5) * s;
      ctx.beginPath();
      ctx.moveTo(x - 3 * s, -6 * s + i * 1.2 * s);
      ctx.lineTo(x, 0);
      ctx.lineTo(x - 3 * s, 6 * s - i * 1.2 * s);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(-14 * s, 0);
    ctx.lineTo(10 * s, 0);
    ctx.stroke();
    ctx.fillStyle = P.joint;
    ctx.beginPath();
    ctx.arc(-13.5 * s, 0, 1.8 * s, 0, TAU);
    ctx.fill();
    ctx.restore();

    // ---- cephalothorax (the "chip" body from the reel, refined) ----------
    const c = this.local(2 * s + this.lunge * 3 * s, 0);
    ctx.save();
    ctx.translate(c.x + ox, c.y + oy - lift);
    ctx.rotate(this.heading);
    // fangs / chelicerae
    const open = 0.25 + this.lunge * 0.7;
    ctx.strokeStyle = P.body;
    ctx.lineWidth = 1.4 * s;
    for (const sd of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(9 * s, sd * 2.5 * s);
      ctx.quadraticCurveTo(14 * s, sd * (3 + open * 4) * s, 15.5 * s, sd * (1 + open * 1.5) * s);
      ctx.stroke();
    }
    // pedipalps (little feelers), twitching
    const tw = Math.sin(this.time * 11) * 0.25;
    ctx.strokeStyle = P.leg;
    ctx.lineWidth = 1.2 * s;
    for (const sd of [1, -1]) {
      const a1 = sd * (0.55 + tw * sd);
      const p1x = 7 * s + Math.cos(a1) * 7 * s;
      const p1y = sd * 4 * s + Math.sin(a1) * 7 * s;
      ctx.beginPath();
      ctx.moveTo(6 * s, sd * 4 * s);
      ctx.lineTo(p1x, p1y);
      ctx.lineTo(p1x + 5 * s, p1y - sd * 1.5 * s);
      ctx.stroke();
      ctx.fillStyle = P.joint;
      ctx.beginPath();
      ctx.arc(p1x, p1y, 1.3 * s, 0, TAU);
      ctx.fill();
    }
    // body plate
    ctx.fillStyle = 'rgba(6,5,14,0.92)';
    ctx.strokeStyle = P.body;
    ctx.lineWidth = 1.5 * s;
    roundRect(ctx, -9 * s, -7.5 * s, 19 * s, 15 * s, 3.5 * s);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = P.leg;
    ctx.lineWidth = 0.9 * s;
    roundRect(ctx, -5 * s, -4 * s, 10 * s, 8 * s, 1.5 * s);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    // core light
    const pulse = 0.65 + 0.35 * Math.sin(this.time * 5 + this.seed);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = P.glow;
    ctx.beginPath();
    ctx.arc(0, 0, 7 * s * pulse, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = P.body;
    ctx.beginPath();
    ctx.arc(0, 0, 1.8 * s, 0, TAU);
    ctx.fill();
    // eyes
    ctx.fillStyle = '#ffffff';
    for (const [ex, ey, r] of [
      [7.4, 2.2, 1.15],
      [7.4, -2.2, 1.15],
      [5.6, 4.6, 0.8],
      [5.6, -4.6, 0.8],
    ]) {
      ctx.beginPath();
      ctx.arc(ex * s, ey * s, r * s, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
