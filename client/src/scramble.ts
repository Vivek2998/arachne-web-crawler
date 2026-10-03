const CHARS = '!<>-_\\/[]{}—=+*^?#0123456789ABCDEFabcdef';
const running = new WeakMap<HTMLElement, number>();

/** Decode-style text scramble: characters resolve left-to-right into the original text. */
export function scramble(el: HTMLElement, duration = 400) {
  const original = el.dataset.text ?? el.textContent ?? '';
  el.dataset.text = original;
  const prev = running.get(el);
  if (prev) cancelAnimationFrame(prev);
  const start = performance.now();
  const n = original.length;
  const frame = (now: number) => {
    const p = (now - start) / duration;
    if (p >= 1) {
      el.textContent = original;
      running.delete(el);
      return;
    }
    let out = '';
    const resolved = Math.floor(p * p * n);
    for (let i = 0; i < n; i++) {
      const ch = original[i];
      out += i < resolved || ch === ' ' ? ch : CHARS[(Math.random() * CHARS.length) | 0];
    }
    el.textContent = out;
    running.set(el, requestAnimationFrame(frame));
  };
  running.set(el, requestAnimationFrame(frame));
}
