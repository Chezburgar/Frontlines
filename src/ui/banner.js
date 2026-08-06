/**
 * Player banners.
 *
 * Drawn to a canvas from a small JSON description rather than stored as images, so a
 * banner costs a few dozen bytes in the profile row and can be rendered at any size — the
 * pre-round intro wants it large, the killfeed wants it 24 px tall.
 */

export const PATTERNS = {
  solid: 'Solid', chevron: 'Chevron', split: 'Split', bars: 'Bars',
  diagonal: 'Diagonal', rays: 'Rays', hex: 'Hex Field', wave: 'Wave',
};

export const EMBLEMS = {
  none: 'None', halo: 'Halo', blade: 'Blade', torii: 'Torii',
  crosshair: 'Crosshair', wolf: 'Fang', anchor: 'Anchor', crown: 'Crown',
};

export const FRAMES = {
  none: 'None', steel: 'Steel', gold: 'Gold', carbon: 'Carbon', crimson: 'Crimson',
};

const FRAME_COLORS = {
  none: null, steel: '#8d98a6', gold: '#d4a94a', carbon: '#2a2e34', crimson: '#a8352c',
};

export const DEFAULT_BANNER = {
  pattern: 'chevron', primary: '#e8873a', secondary: '#141821',
  emblem: 'halo', frame: 'steel',
};

/**
 * Renders a banner into a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {object} b banner description
 */
export function drawBanner(canvas, b = DEFAULT_BANNER, { label = '', level = 0 } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const p = b.primary ?? DEFAULT_BANNER.primary;
  const s = b.secondary ?? DEFAULT_BANNER.secondary;

  ctx.clearRect(0, 0, W, H);
  ctx.save();

  // ---- ground -------------------------------------------------------------
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = p;
  switch (b.pattern) {
    case 'solid':
      ctx.fillRect(0, 0, W, H);
      break;
    case 'split':
      ctx.fillRect(0, 0, W, H / 2);
      break;
    case 'bars':
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) ctx.fillRect(0, (H / 5) * i, W, H / 5);
      }
      break;
    case 'diagonal':
      ctx.beginPath();
      ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      break;
    case 'rays': {
      const cx = W / 2, cy = H * 1.05;
      for (let i = 0; i < 9; i++) {
        const a0 = Math.PI + (i / 9) * Math.PI;
        const a1 = a0 + Math.PI / 18;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, W, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'hex': {
      const r = H / 7;
      ctx.globalAlpha = 0.85;
      for (let row = -1; row * r * 1.5 < H + r; row++) {
        for (let col = -1; col * r * 1.74 < W + r; col++) {
          const x = col * r * 1.74 + (row % 2 ? r * 0.87 : 0);
          const y = row * r * 1.5;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k - Math.PI / 6;
            const px = x + Math.cos(a) * r * 0.82, py = y + Math.sin(a) * r * 0.82;
            k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.closePath();
          if ((row + col) % 2 === 0) ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'wave':
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 4) {
        ctx.lineTo(x, H * 0.55 + Math.sin((x / W) * Math.PI * 3) * H * 0.16);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      break;
    case 'chevron':
    default:
      ctx.beginPath();
      ctx.moveTo(0, H); ctx.lineTo(W * 0.5, H * 0.18); ctx.lineTo(W, H);
      ctx.closePath(); ctx.fill();
      break;
  }

  // ---- emblem -------------------------------------------------------------
  if (b.emblem && b.emblem !== 'none') {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    const R = Math.min(W, H) * 0.24;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.lineWidth = Math.max(2, R * 0.14);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawEmblem(ctx, b.emblem, R);
    ctx.restore();
  }

  // ---- frame --------------------------------------------------------------
  const fc = FRAME_COLORS[b.frame];
  if (fc) {
    ctx.strokeStyle = fc;
    ctx.lineWidth = Math.max(2, H * 0.045);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  }

  // ---- label --------------------------------------------------------------
  if (label) {
    const fs = Math.max(10, H * 0.17);
    ctx.font = `600 ${fs}px Rajdhani, 'Barlow Condensed', sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, H - fs * 1.5, W, fs * 1.5);
    ctx.fillStyle = '#eef3f8';
    ctx.fillText(label.toUpperCase(), H * 0.08, H - fs * 0.32);
    if (level) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#d4a94a';
      ctx.fillText(String(level), W - H * 0.08, H - fs * 0.32);
    }
  }

  ctx.restore();
  return canvas;
}

function drawEmblem(ctx, kind, R) {
  switch (kind) {
    case 'halo':
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, R * 0.52, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'blade':
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.15); ctx.lineTo(R * 0.34, R * 0.5);
      ctx.lineTo(0, R * 1.0); ctx.lineTo(-R * 0.34, R * 0.5);
      ctx.closePath(); ctx.fill();
      break;
    case 'torii':
      ctx.lineWidth = R * 0.2;
      ctx.beginPath();
      ctx.moveTo(-R * 1.05, -R * 0.62); ctx.lineTo(R * 1.05, -R * 0.62);
      ctx.moveTo(-R * 0.82, -R * 0.22); ctx.lineTo(R * 0.82, -R * 0.22);
      ctx.moveTo(-R * 0.55, -R * 0.62); ctx.lineTo(-R * 0.55, R * 0.95);
      ctx.moveTo(R * 0.55, -R * 0.62); ctx.lineTo(R * 0.55, R * 0.95);
      ctx.stroke();
      break;
    case 'crosshair':
      ctx.beginPath(); ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.1); ctx.lineTo(0, -R * 0.3);
      ctx.moveTo(0, R * 0.3); ctx.lineTo(0, R * 1.1);
      ctx.moveTo(-R * 1.1, 0); ctx.lineTo(-R * 0.3, 0);
      ctx.moveTo(R * 0.3, 0); ctx.lineTo(R * 1.1, 0);
      ctx.stroke();
      break;
    case 'wolf':
      ctx.beginPath();
      ctx.moveTo(-R * 0.75, -R * 0.7); ctx.lineTo(-R * 0.25, R * 0.9);
      ctx.lineTo(0, R * 0.2); ctx.lineTo(R * 0.25, R * 0.9);
      ctx.lineTo(R * 0.75, -R * 0.7); ctx.lineTo(0, -R * 0.1);
      ctx.closePath(); ctx.fill();
      break;
    case 'anchor':
      ctx.beginPath();
      ctx.moveTo(0, -R); ctx.lineTo(0, R * 0.85);
      ctx.moveTo(-R * 0.55, 0); ctx.lineTo(R * 0.55, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, R * 0.35, R * 0.72, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      break;
    case 'crown':
      ctx.beginPath();
      ctx.moveTo(-R, R * 0.6); ctx.lineTo(-R * 0.78, -R * 0.6);
      ctx.lineTo(-R * 0.35, R * 0.05); ctx.lineTo(0, -R * 0.85);
      ctx.lineTo(R * 0.35, R * 0.05); ctx.lineTo(R * 0.78, -R * 0.6);
      ctx.lineTo(R, R * 0.6);
      ctx.closePath(); ctx.fill();
      break;
    default:
      break;
  }
}

/** Convenience: a detached canvas at a given size, ready to insert. */
export function bannerCanvas(b, w = 320, h = 120, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawBanner(c, b, opts);
  return c;
}

/* ---------------------------------------------------------------- weapon skins */

/**
 * Weapon skins are colour/finish recipes applied to the procedural weapon materials —
 * there is no texture to download, and a skin works on every weapon automatically.
 */
export const SKINS = {
  default: { name: 'Standard', steel: 0x33373c, polymer: 0x24262a, accent: 0x1a1c1f, metalness: 0.85, roughness: 0.42 },
  sand: { name: 'Desert', steel: 0x6d6250, polymer: 0x5c5342, accent: 0x3a352c, metalness: 0.5, roughness: 0.62 },
  woodland: { name: 'Woodland', steel: 0x3d4a38, polymer: 0x2f3a2c, accent: 0x232a21, metalness: 0.45, roughness: 0.7 },
  arctic: { name: 'Arctic', steel: 0xc8cfd6, polymer: 0xaeb6bd, accent: 0x6f767d, metalness: 0.6, roughness: 0.48 },
  crimson: { name: 'Crimson Guard', steel: 0x7d2b24, polymer: 0x2a1d1b, accent: 0x431714, metalness: 0.75, roughness: 0.35 },
  gilded: { name: 'Gilded', steel: 0xd4a94a, polymer: 0x2a2418, accent: 0x8a6d2c, metalness: 0.95, roughness: 0.22 },
  obsidian: { name: 'Obsidian', steel: 0x14161a, polymer: 0x0d0e11, accent: 0x22262b, metalness: 0.9, roughness: 0.26 },
  lacquer: { name: 'Urushi', steel: 0x2b1416, polymer: 0x8c2b22, accent: 0xd4a94a, metalness: 0.6, roughness: 0.18 },
};

/** Applies a skin to a built weapon model's material set. */
export function applySkin(materials, skinId) {
  const s = SKINS[skinId] ?? SKINS.default;
  materials.steel.color.setHex(s.steel);
  materials.steel.metalness = s.metalness;
  materials.steel.roughness = s.roughness;
  materials.polymer.color.setHex(s.polymer);
  materials.polymer.roughness = Math.min(0.95, s.roughness + 0.3);
  materials.accent.color.setHex(s.accent);
  return materials;
}
