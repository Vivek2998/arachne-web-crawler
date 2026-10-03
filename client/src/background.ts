const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec4 uRip[10];
uniform float uEnergy;
uniform vec2 uWeb;
out vec4 outColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  float px = 1.0 / uRes.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float aspect = uRes.x / uRes.y;

  // --- shockwaves from crawl events: displace space + glow ring -----------
  vec2 disp = vec2(0.0);
  float ring = 0.0;
  for (int i = 0; i < 10; i++) {
    vec4 r = uRip[i];
    if (r.w <= 0.0) continue;
    vec2 c = vec2((r.x - 0.5) * aspect, 0.5 - r.y);
    float age = uTime - r.z;
    if (age < 0.0 || age > 4.0) continue;
    float rad = age * 0.42;
    vec2 dv = p - c;
    float d = length(dv);
    float w = exp(-pow((d - rad) * 16.0, 2.0)) * exp(-age * 1.25) * r.w;
    disp += (dv / max(d, 1e-4)) * w * 0.018;
    ring += w;
  }
  vec2 q = p + disp;

  // --- nebula -------------------------------------------------------------
  float t = uTime;
  vec2 nq = q * 1.35;
  float warp = fbm(nq * 1.6 + vec2(t * 0.025, -t * 0.02));
  float n1 = fbm(nq + warp * 1.4 + vec2(-t * 0.012, t * 0.01));
  float n2 = fbm(nq * 0.75 + 4.0 - warp + vec2(t * 0.008, 0.0));
  vec3 col = vec3(0.010, 0.008, 0.022);
  col += vec3(0.30, 0.09, 0.62) * smoothstep(0.42, 0.95, n1) * 0.42;
  col += vec3(0.02, 0.36, 0.46) * smoothstep(0.5, 1.0, n2) * 0.34;
  col += vec3(0.65, 0.12, 0.42) * smoothstep(0.62, 1.0, n1 * n2 * 1.9) * 0.18;

  // --- a giant orb web, breathing and vibrating ----------------------------
  vec2 wc = vec2((uWeb.x - 0.5) * aspect, 0.5 - uWeb.y);
  vec2 w = q - wc;
  w += vec2(sin(t * 0.21 + w.y * 3.0), cos(t * 0.17 + w.x * 3.0)) * 0.006;
  float r = length(w);
  float ang = atan(w.y, w.x);
  float N = 22.0;
  float a = ang / 6.2831853 * N;
  float spokeD = abs(a - floor(a + 0.5)) * 6.2831853 / N * r;
  float spoke = 1.0 - smoothstep(0.0, px * 1.4, spokeD);
  float f = fract(a);
  float sag = 0.014 * sin(f * 3.14159) * smoothstep(0.05, 0.4, r);
  float sp = 0.058 + r * 0.02;
  float x = (r + sag) / sp;
  float ringD = abs(x - floor(x + 0.5)) * sp;
  float spiral = 1.0 - smoothstep(0.0, px * 1.3, ringD);
  float webMask = smoothstep(1.45, 0.05, r) * smoothstep(0.015, 0.06, r);
  float web = max(spoke * 0.85, spiral) * webMask;
  // dew drops on intersections
  float drop = spoke * spiral * webMask;
  float shimmer = 0.6 + 0.4 * sin(t * 1.3 + r * 18.0 - ang * 3.0);
  col += vec3(0.62, 0.66, 1.0) * web * (0.055 + uEnergy * 0.03) * shimmer * (1.0 + ring * 10.0);
  col += vec3(0.6, 0.95, 1.0) * drop * 0.25;

  // --- mouse aura + shockwave glow -----------------------------------------
  vec2 m = vec2((uMouse.x - 0.5) * aspect, 0.5 - uMouse.y);
  col += vec3(0.32, 0.18, 0.75) * 0.075 * exp(-length(p - m) * 3.2);
  col += vec3(0.25, 0.85, 1.0) * ring * 0.22;

  // --- finish: vignette + grain --------------------------------------------
  vec2 uv = gl_FragCoord.xy / uRes;
  float vig = smoothstep(1.25, 0.25, length((uv - 0.5) * vec2(aspect, 1.0)));
  col *= 0.45 + 0.55 * vig;
  col += (hash(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.018;
  outColor = vec4(col, 1.0);
}`;

/** Full-screen WebGL2 background that reacts to crawl activity. */
export class Background {
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private ripples = new Float32Array(40);
  private rippleIdx = 0;
  private mouse = { x: 0.5, y: 0.4, tx: 0.5, ty: 0.4 };
  private web = { x: 0.78, y: 0.28 };
  energy = 0;
  private scaleFactor = 0.6;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!this.gl) {
      canvas.classList.add('no-webgl');
      return;
    }
    this.init();
    window.addEventListener('pointermove', (e) => {
      this.mouse.tx = e.clientX / innerWidth;
      this.mouse.ty = e.clientY / innerHeight;
    });
  }

  private init() {
    const gl = this.gl!;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      this.gl = null;
      return;
    }
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uTime', 'uMouse', 'uRip', 'uEnergy', 'uWeb']) this.u[n] = gl.getUniformLocation(prog, n);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // render at reduced resolution: it's soft imagery, the GPU thanks us
    this.scaleFactor = innerWidth * innerHeight > 2_000_000 ? 0.5 : 0.65;
    this.canvas.width = Math.round(innerWidth * dpr * this.scaleFactor);
    this.canvas.height = Math.round(innerHeight * dpr * this.scaleFactor);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Emit a shockwave at a screen position (CSS pixels). */
  ripple(x: number, y: number, strength = 1, time: number) {
    const i = this.rippleIdx++ % 10;
    this.ripples.set([x / innerWidth, y / innerHeight, time, strength], i * 4);
    this.energy = Math.min(1, this.energy + 0.15 * strength);
  }

  render(time: number, dt: number) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const k = 1 - Math.exp(-3 * dt);
    this.mouse.x += (this.mouse.tx - this.mouse.x) * k;
    this.mouse.y += (this.mouse.ty - this.mouse.y) * k;
    this.energy *= Math.exp(-0.6 * dt);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform2f(this.u.uMouse, this.mouse.x, this.mouse.y);
    gl.uniform4fv(this.u.uRip, this.ripples);
    gl.uniform1f(this.u.uEnergy, this.energy);
    gl.uniform2f(this.u.uWeb, this.web.x, this.web.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
