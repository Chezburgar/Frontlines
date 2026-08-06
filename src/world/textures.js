/**
 * Procedural texture library.
 *
 * Every surface in Teahouse is generated here rather than shipped as image files: it keeps
 * the download tiny, lets each material tile seamlessly at any scale, and means albedo,
 * normal and roughness always agree with each other (a normal map derived from the same
 * height field that carved the albedo never looks pasted on).
 *
 * Each generator returns a height field alongside the colour buffer; `buildMaterialMaps`
 * differentiates the height into a tangent-space normal and packs roughness/AO, so adding
 * a new surface only means describing how it looks, not authoring three textures.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ helpers */

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Tiling value-noise field. Wraps exactly, so every texture is seamless. */
export function noiseField(size, freq, seed) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(freq * freq);
  for (let i = 0; i < freq * freq; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * freq, fy = (y / size) * freq;
      const x0 = Math.floor(fx) % freq, y0 = Math.floor(fy) % freq;
      const x1 = (x0 + 1) % freq, y1 = (y0 + 1) % freq;
      const tx = smooth(fx - Math.floor(fx)), ty = smooth(fy - Math.floor(fy));
      const a = g[y0 * freq + x0], b = g[y0 * freq + x1];
      const c = g[y1 * freq + x0], d = g[y1 * freq + x1];
      out[y * size + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return out;
}

/** Sum of octaves — the general-purpose grain used by most surfaces. */
export function fbm(size, octaves, seed, baseFreq = 4, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const n = noiseField(size, Math.max(2, Math.round(freq)), seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp; amp *= gain; freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/* --------------------------------------------------------------- map packing */

/**
 * Turns a colour buffer + height field into the three textures a PBR material wants.
 * `roughnessFn(height, x, y)` lets a surface vary its finish with its own structure —
 * lacquer sitting in the low spots of wood grain, for example.
 */
export function buildMaterialMaps(size, colour, height, opts = {}) {
  const {
    normalStrength = 2.0,
    roughness = 0.8,
    roughnessVar = 0.12,
    roughnessFn = null,
    repeat = [1, 1],
    aniso = 16,
  } = opts;

  const albedo = new THREE.DataTexture(colour, size, size, THREE.RGBAFormat);
  albedo.colorSpace = THREE.SRGBColorSpace;

  // Normals from the height field's gradient. Wrapping the lookups keeps the seam clean.
  const nrm = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * normalStrength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * normalStrength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nrm[i] = (dx * inv * 0.5 + 0.5) * 255;
      nrm[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      nrm[i + 2] = (inv * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;

      const h = height[y * size + x];
      const r = roughnessFn ? roughnessFn(h, x, y) : clamp01(roughness + (h - 0.5) * roughnessVar);
      // three reads roughness from G and metalness from B of the same map.
      rgh[i] = 255;
      rgh[i + 1] = r * 255;
      rgh[i + 2] = 0;
      rgh[i + 3] = 255;
    }
  }

  const normal = new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat);
  const rough = new THREE.DataTexture(rgh, size, size, THREE.RGBAFormat);

  for (const t of [albedo, normal, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = aniso;
    t.needsUpdate = true;
  }
  return { map: albedo, normalMap: normal, roughnessMap: rough };
}

/** Writes an RGB triple into a colour buffer. */
function put(buf, i, r, g, b) {
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}

/* ============================================================== generators */

/**
 * Tatami — woven rush (igusa) running in one direction, with the tight ribbing that
 * catches light across the weave. Mats are laid in alternating orientation in-game, so the
 * texture only needs one direction and the builder rotates UVs.
 */
export function tatamiTexture(size = 512, seed = 11) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const grain = fbm(size, 4, seed, 24, 0.55);
  const blotch = fbm(size, 3, seed + 31, 3, 0.6);

  const WEAVE = 74;                 // rush strands across the mat
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (y / size) * WEAVE;
      const rib = Math.abs((t % 1) - 0.5) * 2;        // 0 at strand centre, 1 at the gap
      const strand = Math.floor(t);
      const rnd = mulberry32(strand * 2654435761 + seed)();

      // Aged rush shifts from green toward straw; vary per strand so it reads as woven.
      const age = clamp01(0.42 + blotch[y * size + x] * 0.5 + rnd * 0.18);
      const g0 = grain[y * size + x];
      let r = lerp(196, 154, age) + g0 * 26 - rib * 22;
      let g = lerp(188, 160, age) + g0 * 22 - rib * 20;
      let b = lerp(126, 96, age) + g0 * 18 - rib * 16;

      // Fine warp threads crossing the rush.
      if (Math.floor(x / size * 128) % 32 === 0) { r *= 0.9; g *= 0.9; b *= 0.88; }

      put(colour, i, r, g, b);
      height[y * size + x] = 0.5 + (1 - rib) * 0.34 + g0 * 0.12;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 3.0, roughness: 0.93, roughnessVar: 0.06, repeat: [1, 1],
  });
}

/**
 * Hinoki / cedar timber. Straight grain with occasional knots — used for posts, beams,
 * floorboards and door frames, with the builder scaling UVs per element so a 4 m beam does
 * not show the same grain as a 200 mm sill.
 */
export function woodTexture(size = 512, seed = 5, tone = 'light') {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const wobble = fbm(size, 4, seed, 5, 0.55);
  const fine = fbm(size, 3, seed + 77, 40, 0.5);

  const palettes = {
    light: [198, 168, 126, 150, 118, 80],     // hinoki
    warm: [168, 122, 78, 112, 74, 44],        // aged cedar
    dark: [92, 63, 44, 54, 35, 24],           // stained keyaki
  };
  const p = palettes[tone] || palettes.light;

  // Knots: a few radial disturbances that the grain bends around.
  const rnd = mulberry32(seed * 31 + 7);
  const knots = Array.from({ length: 3 }, () => ({
    x: rnd() * size, y: rnd() * size, r: 12 + rnd() * 26, s: 0.5 + rnd(),
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      let warp = wobble[y * size + x] * 26;
      let knotDark = 0;
      for (const k of knots) {
        const dx = Math.min(Math.abs(x - k.x), size - Math.abs(x - k.x));
        const dy = Math.min(Math.abs(y - k.y), size - Math.abs(y - k.y));
        const d = Math.hypot(dx, dy);
        if (d < k.r * 3) {
          warp += Math.cos(d * 0.5) * (k.r * 3 - d) * 0.5 * k.s;
          if (d < k.r) knotDark = Math.max(knotDark, (1 - d / k.r) * 0.75);
        }
      }

      // Growth rings: a band function across x, bent by the warp.
      // Kept low-frequency on purpose — at 0.16 the rings aliased into a corduroy moire
      // once the texture tiled across a whole wall.
      const ring = Math.abs(Math.sin((x + warp) * 0.045 + wobble[y * size + x] * 1.4));
      const g1 = fine[y * size + x];
      const band = Math.pow(ring, 0.75);

      let r = lerp(p[0], p[3], band) + g1 * 11 - knotDark * 70;
      let g = lerp(p[1], p[4], band) + g1 * 9 - knotDark * 52;
      let b = lerp(p[2], p[5], band) + g1 * 7 - knotDark * 38;

      put(colour, i, r, g, b);
      height[y * size + x] = 0.5 - band * 0.22 - knotDark * 0.25 + g1 * 0.16;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 1.7, roughness: 0.72, roughnessVar: 0.18,
  });
}

/**
 * Shoji — translucent washi paper over a kumiko lattice. The lattice is baked into the
 * albedo and height so a single quad reads as a full screen; the builder gives it a
 * transmissive material so silhouettes show through, which is the whole point of shoji as
 * a peek surface.
 */
export function shojiTexture(size = 512, seed = 19) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const fibre = fbm(size, 3, seed, 70, 0.5);
  const stain = fbm(size, 3, seed + 13, 4, 0.6);

  const COLS = 6, ROWS = 9;         // kumiko grid
  const BAR = 0.055;                 // bar half-width in cell units

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x / size) * COLS, v = (y / size) * ROWS;
      const du = Math.abs((u % 1) - 0.5), dv = Math.abs((v % 1) - 0.5);
      const onBar = du > 0.5 - BAR * COLS / 3 || dv > 0.5 - BAR * ROWS / 3;

      const f = fibre[y * size + x], s = stain[y * size + x];
      if (onBar) {
        // Dark timber lattice.
        const d = 96 + f * 30;
        put(colour, i, d * 0.74, d * 0.58, d * 0.42);
        height[y * size + x] = 0.82;
      } else {
        // Aged paper: warm white with visible fibre and light foxing.
        const base = 232 - s * 26;
        put(colour, i, base, base - 4 + f * 8, base - 16 + f * 6);
        height[y * size + x] = 0.46 + f * 0.08;
      }
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 2.2, roughness: 0.86, roughnessVar: 0.08,
  });
}

/**
 * Shikkui — lime plaster over earthen wall. The dominant interior surface, so it carries
 * most of the trowel character; kept subtle because it tiles across large areas.
 */
export function plasterTexture(size = 512, seed = 3, tint = [226, 219, 203]) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const coarse = fbm(size, 4, seed, 6, 0.6);
  const fine = fbm(size, 4, seed + 41, 34, 0.5);
  const trowel = fbm(size, 2, seed + 91, 3, 0.7);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = coarse[y * size + x], f = fine[y * size + x], t = trowel[y * size + x];
      // Broad trowel sweeps plus a fine aggregate speckle.
      const shade = (c - 0.5) * 16 + (f - 0.5) * 9 + (t - 0.5) * 12;
      put(colour, i, tint[0] + shade, tint[1] + shade, tint[2] + shade * 0.9);
      height[y * size + x] = 0.5 + (c - 0.5) * 0.5 + (f - 0.5) * 0.22;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 1.5, roughness: 0.94, roughnessVar: 0.05,
  });
}

/**
 * Kawara — fired clay roof tile. Also used for the perimeter wall capping.
 */
export function roofTileTexture(size = 512, seed = 23) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const grain = fbm(size, 3, seed, 28, 0.5);
  const wear = fbm(size, 3, seed + 17, 5, 0.6);

  const COLS = 8, ROWS = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x / size) * COLS;
      const v = (y / size) * ROWS;
      const cu = u % 1, cv = v % 1;

      // Each tile is a shallow barrel with a raised overlap on one edge.
      const barrel = Math.sin(cu * Math.PI);
      const overlap = cu < 0.14 ? 1 : 0;
      const gap = cv > 0.9 ? 1 : 0;

      const g = grain[y * size + x], w = wear[y * size + x];
      let base = 62 + g * 26 + w * 20 - gap * 26 + barrel * 16 + overlap * 10;
      // Weathered clay drifts slightly blue-grey where it stays wet.
      put(colour, i, base * 1.02, base * 1.04, base * 1.12);
      height[y * size + x] = 0.35 + barrel * 0.4 + overlap * 0.18 - gap * 0.3 + g * 0.08;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 2.6, roughness: 0.8, roughnessVar: 0.14,
  });
}

/**
 * Granite paving / garden stone, used for the genkan step, courtyard path and foundations.
 */
export function stoneTexture(size = 512, seed = 29, tint = [128, 126, 122]) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const speckle = fbm(size, 3, seed, 90, 0.45);
  const blotch = fbm(size, 4, seed + 61, 7, 0.55);

  // Irregular flagstones via a jittered grid, joints carved into the height field.
  const CELLS = 4;
  const rnd = mulberry32(seed + 5);
  const pts = [];
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      pts.push([(cx + 0.2 + rnd() * 0.6) / CELLS, (cy + 0.2 + rnd() * 0.6) / CELLS]);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x / size, py = y / size;
      // Nearest and second-nearest give a Worley edge distance = the mortar joint.
      let d1 = 9, d2 = 9;
      for (const [qx, qy] of pts) {
        let dx = Math.abs(px - qx); dx = Math.min(dx, 1 - dx);
        let dy = Math.abs(py - qy); dy = Math.min(dy, 1 - dy);
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
      const joint = clamp01((d2 - d1) / 0.035);
      const sp = speckle[y * size + x], bl = blotch[y * size + x];
      const shade = (sp - 0.5) * 46 + (bl - 0.5) * 22;
      const lit = joint * 1.0;
      put(colour,
        i,
        (tint[0] + shade) * (0.55 + 0.45 * lit),
        (tint[1] + shade) * (0.55 + 0.45 * lit),
        (tint[2] + shade) * (0.55 + 0.45 * lit));
      height[y * size + x] = 0.3 + joint * 0.5 + (sp - 0.5) * 0.16;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 2.4, roughness: 0.88, roughnessVar: 0.12,
  });
}

/**
 * Fusuma — opaque sliding panel with a painted ground. Unlike shoji these are solid, so
 * they block sight but not bullets, which makes them the map's cheapest soft cover.
 */
export function fusumaTexture(size = 512, seed = 37) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const fibre = fbm(size, 3, seed, 60, 0.5);
  const cloud = fbm(size, 4, seed + 3, 4, 0.6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const f = fibre[y * size + x], c = cloud[y * size + x];
      // Muted gold-leaf ground with ink-wash drift — reads as painted paper at distance.
      const gold = clamp01(0.55 + c * 0.5);
      let r = lerp(176, 208, gold) + f * 14;
      let g = lerp(158, 186, gold) + f * 12;
      let b = lerp(118, 138, gold) + f * 10;
      // Ink wash in the lower third.
      const wash = clamp01((y / size - 0.55) * 2.2) * (0.35 + c * 0.5);
      r = lerp(r, 74, wash * 0.55); g = lerp(g, 78, wash * 0.55); b = lerp(b, 82, wash * 0.55);
      put(colour, i, r, g, b);
      height[y * size + x] = 0.5 + f * 0.1;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 1.2, roughness: 0.8, roughnessVar: 0.1,
  });
}

/** Dark-stained structural timber for posts, beams and the roof frame. */
export function darkWoodTexture(size = 512, seed = 47) {
  return woodTexture(size, seed, 'dark');
}

/** Raked gravel for the karesansui garden. */
export function gravelTexture(size = 512, seed = 53) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const grit = fbm(size, 3, seed, 110, 0.45);
  const drift = fbm(size, 3, seed + 9, 6, 0.6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Raked furrows.
      const rake = Math.sin((x / size) * Math.PI * 2 * 14 + drift[y * size + x] * 3) * 0.5 + 0.5;
      const g = grit[y * size + x];
      // Real gravel reflects ~25-35%. The earlier value (0.7-0.9) was physically wrong and
      // blew straight to white the moment the sun was raised over the courtyard.
      const base = 88 + g * 44 - rake * 18;
      put(colour, i, base, base * 0.99, base * 0.93);
      height[y * size + x] = 0.4 + rake * 0.26 + g * 0.3;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 2.8, roughness: 0.96, roughnessVar: 0.04,
  });
}

/** Brushed/blued steel for reinforcements, hatches, fittings and the drone. */
export function metalTexture(size = 256, seed = 59) {
  const colour = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const brush = fbm(size, 3, seed, 120, 0.4);
  const patina = fbm(size, 3, seed + 21, 5, 0.6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const b = brush[y * size + x], p = patina[y * size + x];
      const base = 84 + b * 34 + p * 16;
      put(colour, i, base * 0.96, base * 0.98, base * 1.04);
      height[y * size + x] = 0.5 + (b - 0.5) * 0.5;
    }
  }
  return buildMaterialMaps(size, colour, height, {
    normalStrength: 1.0, roughness: 0.42, roughnessVar: 0.2,
  });
}
