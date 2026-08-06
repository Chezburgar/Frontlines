/**
 * Cold-open title card.
 *
 * Drawn on a 2D canvas rather than composed from DOM so the timing is frame-exact and the
 * whole thing can run before the WebGL context or any assets exist. Palette is the
 * Chezburger Pro "Obsidian & Gold" set so the card reads as continuous with the site.
 */

const GOLD = '#d4a94a';
const GOLD_LIGHT = '#f6d97a';
const GOLD_PALE = '#ffe08a';
const GOLD_DARK = '#96702a';
const OBSIDIAN = '#0a0a0c';

const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const seg = (t, a, b) => clamp01((t - a) / (b - a));

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onDone?: () => void, skippable?: boolean, duration?: number }} opts
 */
export function playIntro(canvas, opts = {}) {
  const DURATION = opts.duration ?? 5200;
  const ctx = canvas.getContext('2d', { alpha: false });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const CSS_W = 1100, CSS_H = 620;
  canvas.width = CSS_W * dpr;
  canvas.height = CSS_H * dpr;
  ctx.scale(dpr, dpr);

  // Deterministic dust motes drifting through the light — cheap depth cue behind the type.
  const motes = Array.from({ length: 90 }, (_, i) => {
    const r = mulberry(i * 2654435761);
    return {
      x: r() * CSS_W, y: r() * CSS_H,
      z: 0.25 + r() * 0.9,
      vx: (r() - 0.5) * 5, vy: -3 - r() * 7,
      p: r() * Math.PI * 2,
    };
  });

  let start = null;
  let done = false;
  let raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onSkip);
    window.removeEventListener('pointerdown', onSkip);
    opts.onDone?.();
  }
  function onSkip(e) {
    if (e.type === 'keydown' && !['Escape', 'Space', 'Enter'].includes(e.code)) return;
    finish();
  }
  if (opts.skippable !== false) {
    window.addEventListener('keydown', onSkip);
    window.addEventListener('pointerdown', onSkip);
  }

  function frame(now) {
    if (start === null) start = now;
    const t = (now - start) / DURATION;
    draw(clamp01(t), (now - start) / 1000);
    if (t >= 1) { finish(); return; }
    raf = requestAnimationFrame(frame);
  }

  function draw(t, seconds) {
    const W = CSS_W, H = CSS_H, CX = W / 2, CY = H / 2;

    ctx.fillStyle = OBSIDIAN;
    ctx.fillRect(0, 0, W, H);

    // ---- warm pool of light behind everything -----------------------------
    const glowT = seg(t, 0.02, 0.34) * (1 - seg(t, 0.86, 1.0) * 0.85);
    if (glowT > 0) {
      const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, W * 0.52);
      g.addColorStop(0, `rgba(212,169,74,${0.13 * glowT})`);
      g.addColorStop(0.42, `rgba(150,112,42,${0.055 * glowT})`);
      g.addColorStop(1, 'rgba(10,10,12,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // ---- drifting motes ----------------------------------------------------
    const moteA = seg(t, 0.08, 0.3) * (1 - seg(t, 0.88, 1));
    if (moteA > 0.01) {
      for (const m of motes) {
        const x = ((m.x + m.vx * seconds) % (W + 40) + W + 40) % (W + 40) - 20;
        const y = ((m.y + m.vy * seconds) % (H + 40) + H + 40) % (H + 40) - 20;
        const tw = 0.55 + 0.45 * Math.sin(seconds * 1.6 + m.p);
        const d = Math.hypot(x - CX, y - CY) / (W * 0.55);
        const a = moteA * m.z * tw * 0.5 * Math.max(0, 1 - d);
        if (a <= 0.004) continue;
        ctx.fillStyle = `rgba(246,217,122,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, m.z * 1.25, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- the sweeping rule -------------------------------------------------
    // A single gold line wipes out from centre, holds, then the type rises through it.
    const lineT = easeOutQuint(seg(t, 0.06, 0.42));
    const lineFade = 1 - seg(t, 0.80, 0.98);
    if (lineT > 0 && lineFade > 0) {
      const halfW = lineT * W * 0.34;
      const y = CY + 26;
      const lg = ctx.createLinearGradient(CX - halfW, 0, CX + halfW, 0);
      lg.addColorStop(0, 'rgba(150,112,42,0)');
      lg.addColorStop(0.5, `rgba(246,217,122,${0.95 * lineFade})`);
      lg.addColorStop(1, 'rgba(150,112,42,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(CX - halfW, y, halfW * 2, 1.4);

      // travelling highlight
      const sweep = seg(t, 0.10, 0.50);
      if (sweep > 0 && sweep < 1) {
        const sx = CX - halfW + sweep * halfW * 2;
        const sg = ctx.createRadialGradient(sx, y, 0, sx, y, 90);
        sg.addColorStop(0, `rgba(255,224,138,${0.7 * lineFade})`);
        sg.addColorStop(1, 'rgba(255,224,138,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(sx - 90, y - 8, 180, 18);
      }
    }

    // ---- "A CHEZBURGER PRO EXCLUSIVE" -------------------------------------
    const label = 'A CHEZBURGER PRO EXCLUSIVE';
    const typeIn = easeOutQuint(seg(t, 0.20, 0.56));
    const typeOut = seg(t, 0.78, 0.97);
    const typeA = typeIn * (1 - typeOut);

    if (typeA > 0.001) {
      const size = 40;
      ctx.font = `600 ${size}px 'Rajdhani','Barlow Condensed','Oswald','Segoe UI',sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      // Letter-spacing has to be done by hand on canvas; track out generously for the
      // "premium title card" feel, and let each glyph settle in sequence.
      const tracking = 9.5 + (1 - typeIn) * 16;
      const chars = [...label];
      const widths = chars.map((c) => ctx.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);

      let x = CX - total / 2;
      const baseY = CY - 4 + (1 - typeIn) * 22;

      for (let i = 0; i < chars.length; i++) {
        const stagger = i / chars.length;
        const ca = clamp01((typeIn - stagger * 0.35) / 0.65) * (1 - typeOut);
        if (ca > 0.002 && chars[i] !== ' ') {
          const lift = (1 - ca) * 10;
          ctx.save();
          ctx.globalAlpha = ca;
          ctx.shadowColor = `rgba(212,169,74,${0.5 * ca})`;
          ctx.shadowBlur = 22;
          const grad = ctx.createLinearGradient(0, baseY - size, 0, baseY + 6);
          grad.addColorStop(0, GOLD_PALE);
          grad.addColorStop(0.5, GOLD_LIGHT);
          grad.addColorStop(1, GOLD);
          ctx.fillStyle = grad;
          ctx.fillText(chars[i], x + widths[i] / 2, baseY + lift);
          ctx.restore();
        }
        x += widths[i] + tracking;
      }
    }

    // ---- FRONTLINES wordmark ----------------------------------------------
    const markIn = easeInOutCubic(seg(t, 0.50, 0.80));
    const markOut = seg(t, 0.88, 1.0);
    const markA = markIn * (1 - markOut);
    if (markA > 0.001) {
      const size = 74;
      ctx.font = `700 ${size}px 'Rajdhani','Barlow Condensed','Oswald','Segoe UI',sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tracking = 15;
      const word = 'FRONTLINES';
      const chars = [...word];
      const widths = chars.map((c) => ctx.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
      let x = CX - total / 2;
      const y = CY + 96 - (1 - markIn) * 8;

      for (let i = 0; i < chars.length; i++) {
        // "FRONT" gold, "LINES" pale steel — the same split the wordmark uses in the shell.
        const isFront = i < 5;
        ctx.save();
        ctx.globalAlpha = markA;
        ctx.shadowColor = isFront ? `rgba(212,169,74,${0.45 * markA})` : `rgba(200,214,232,${0.2 * markA})`;
        ctx.shadowBlur = 18;
        const grad = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
        if (isFront) {
          grad.addColorStop(0, GOLD_PALE); grad.addColorStop(0.55, GOLD); grad.addColorStop(1, GOLD_DARK);
        } else {
          grad.addColorStop(0, '#eef3fa'); grad.addColorStop(0.55, '#c3ccda'); grad.addColorStop(1, '#7d8798');
        }
        ctx.fillStyle = grad;
        ctx.fillText(chars[i], x + widths[i] / 2, y);
        ctx.restore();
        x += widths[i] + tracking;
      }
    }

    // ---- vignette + grain --------------------------------------------------
    const vg = ctx.createRadialGradient(CX, CY, H * 0.25, CX, CY, H * 0.86);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // Final fade to black hands off cleanly to the shell.
    const out = seg(t, 0.93, 1.0);
    if (out > 0) {
      ctx.fillStyle = `rgba(10,10,12,${out})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  raf = requestAnimationFrame(frame);
  return { skip: finish };
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
