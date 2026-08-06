/**
 * Frontlines asset pipeline.
 *
 * The source map (`r6_maps_luna-park.glb`) is a 95 MB Z-up export whose three floors
 * carry an "exploded view" animation and sit on separate node transforms. Shipping it
 * as-is would mean a ~95 MB download and three unculled 250k-triangle draw calls.
 *
 * This pass:
 *   1. bakes node transforms into vertex data and rotates the world Z-up -> Y-up,
 *   2. re-centres the map on the origin with the ground floor at y = 0,
 *   3. splits every mesh into a spatial grid of chunks so the renderer can frustum-cull
 *      aggressively inside tight interiors,
 *   4. down-samples + WebP-encodes the baked diffuse atlases,
 *   5. quantizes and Meshopt-compresses the geometry (decodes ~10x faster than Draco).
 *
 * Output: public/models/lunapark.glb  (target < 20 MB)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, Document } from '@gltf-transform/core';
import { KHRMeshQuantization, EXTMeshoptCompression, ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, meshopt, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { weldMesh } from './weld.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.FL_SRC || 'C:/Users/chase/Downloads';
const OUT = path.join(ROOT, 'public', 'models');

const CHUNK = 9.0;          // metres per spatial chunk edge
const MAX_TEX = 4096;       // clamp atlas resolution
const CREASE_ANGLE = 42;    // degrees; edges sharper than this stay hard when re-normalling

const log = (...a) => console.log('[pipeline]', ...a);

/* ------------------------------------------------------------------ helpers */

function quatToMat3(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  // column-major 3x3
  return [
    1 - (yy + zz), xy + wz, xz - wy,
    xy - wz, 1 - (xx + zz), yz + wx,
    xz + wy, yz - wx, 1 - (xx + yy),
  ];
}

function applyTRS(p, t, r, s) {
  const m = quatToMat3(r);
  const x = p[0] * s[0], y = p[1] * s[1], z = p[2] * s[2];
  return [
    m[0] * x + m[3] * y + m[6] * z + t[0],
    m[1] * x + m[4] * y + m[7] * z + t[1],
    m[2] * x + m[5] * y + m[8] * z + t[2],
  ];
}

function rotateVecOnly(p, r, s) {
  const m = quatToMat3(r);
  // normal transform: for uniform scale the rotation alone is correct
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z,
  ];
}

/* ------------------------------------------------------------ raw GLB read */

function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(body.toString('utf8'));
    else if (type.startsWith('BIN')) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4 === 4 ? 0 : 0);
  }
  return { json, bin };
}

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g, bin, index) {
  const acc = g.accessors[index];
  const [Ctor, csize] = COMP[acc.componentType];
  const n = NUM[acc.type];
  const out = new Ctor(acc.count * n);
  if (acc.bufferView == null) return out;
  const bv = g.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || n * csize;
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < n; c++) {
      out[i * n + c] = Ctor === Float32Array ? bin.readFloatLE(o + c * csize)
        : Ctor === Uint32Array ? bin.readUInt32LE(o + c * csize)
        : Ctor === Uint16Array ? bin.readUInt16LE(o + c * csize)
        : Ctor === Int16Array ? bin.readInt16LE(o + c * csize)
        : Ctor === Uint8Array ? bin.readUInt8(o + c * csize)
        : bin.readInt8(o + c * csize);
    }
  }
  return out;
}

/* -------------------------------------------------------- orientation fixup */

/** Area-weighted mean normal of the near-horizontal faces = the map's true up axis. */
function dominantUp(floors) {
  // Seed with the raw +Y guess, then refine twice so the "near-horizontal" test tightens
  // around the real floor plane rather than the exporter's approximation of it.
  let up = [0, 1, 0];
  for (let pass = 0; pass < 3; pass++) {
    const acc = [0, 0, 0];
    const cos = pass === 0 ? 0.86 : 0.97;
    for (const f of floors) {
      for (let t = 0; t < f.idx.length; t += 3) {
        const a = f.idx[t], b = f.idx[t + 1], c = f.idx[t + 2];
        const n = triNormal(f.pos, a, b, c);
        const d = n[0] * up[0] + n[1] * up[1] + n[2] * up[2];
        const s = d < 0 ? -1 : 1;            // floors and ceilings both vote for the axis
        if (Math.abs(d) < cos) continue;
        const area = n[3];
        acc[0] += n[0] * s * area; acc[1] += n[1] * s * area; acc[2] += n[2] * s * area;
      }
    }
    const l = Math.hypot(...acc) || 1;
    up = [acc[0] / l, acc[1] / l, acc[2] / l];
  }
  return up;
}

/** Dominant wall bearing, folded into [0, 90 deg) — buildings are overwhelmingly rectilinear. */
function dominantYaw(floors) {
  const BINS = 900;                           // 0.1 deg resolution
  const hist = new Float64Array(BINS);
  for (const f of floors) {
    for (let t = 0; t < f.idx.length; t += 3) {
      const a = f.idx[t], b = f.idx[t + 1], c = f.idx[t + 2];
      const n = triNormal(f.pos, a, b, c);
      if (Math.abs(n[1]) > 0.25) continue;     // keep vertical surfaces only
      let ang = Math.atan2(n[2], n[0]);
      ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      const bin = Math.min(BINS - 1, Math.floor((ang / (Math.PI / 2)) * BINS));
      hist[bin] += n[3];
    }
  }
  // Smooth so a single noisy bin cannot win, then take the circular-aware peak.
  let best = 0, bestV = -1;
  for (let i = 0; i < BINS; i++) {
    let v = 0;
    for (let k = -6; k <= 6; k++) v += hist[(i + k + BINS) % BINS] * (1 - Math.abs(k) / 8);
    if (v > bestV) { bestV = v; best = i; }
  }
  let yaw = (best / BINS) * (Math.PI / 2);
  if (yaw > Math.PI / 4) yaw -= Math.PI / 2;   // rotate the short way
  return yaw;
}

/** Returns [nx, ny, nz, area] for a triangle. */
function triNormal(pos, a, b, c) {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) return [0, 0, 0, 0];
  return [nx / l, ny / l, nz / l, l * 0.5];
}

/** Shortest-arc quaternion rotating `a` onto `b` (both unit length). */
function quatFromTo(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) return [1, 0, 0, 0];
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function rotateBuffers(f, q) {
  const m = quatToMat3(q);
  const apply = (buf) => {
    for (let i = 0; i < buf.length; i += 3) {
      const x = buf[i], y = buf[i + 1], z = buf[i + 2];
      buf[i] = m[0] * x + m[3] * y + m[6] * z;
      buf[i + 1] = m[1] * x + m[4] * y + m[7] * z;
      buf[i + 2] = m[2] * x + m[5] * y + m[8] * z;
    }
  };
  apply(f.pos); apply(f.nor);
}

/* ----------------------------------------------------------------- chunking */

/** Split a primitive's triangles into a spatial grid, returning per-chunk buffers. */
function chunkPrimitive(pos, nor, uv, idx, chunkSize) {
  const cells = new Map();
  const triCount = idx.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
    const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
    const key = `${Math.floor(cx / chunkSize)}_${Math.floor(cy / (chunkSize * 1.6))}_${Math.floor(cz / chunkSize)}`;
    let cell = cells.get(key);
    if (!cell) { cell = { remap: new Map(), pos: [], nor: [], uv: [], idx: [] }; cells.set(key, cell); }
    for (const v of [a, b, c]) {
      let ni = cell.remap.get(v);
      if (ni === undefined) {
        ni = cell.pos.length / 3;
        cell.remap.set(v, ni);
        cell.pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        cell.nor.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
        cell.uv.push(uv[v * 2], uv[v * 2 + 1]);
      }
      cell.idx.push(ni);
    }
  }
  return [...cells.entries()].map(([key, c]) => ({
    key,
    pos: new Float32Array(c.pos),
    nor: new Float32Array(c.nor),
    uv: new Float32Array(c.uv),
    idx: c.pos.length / 3 > 65535 ? new Uint32Array(c.idx) : new Uint16Array(c.idx),
  }));
}

/* --------------------------------------------------------------------- main */

async function buildMap() {
  const srcFile = path.join(SRC, 'r6_maps_luna-park.glb');
  log('reading', srcFile, (fs.statSync(srcFile).size / 1048576).toFixed(1), 'MB');
  const { json: g, bin } = readGLB(srcFile);

  // 1. Bake node transforms. The Blender glTF exporter already folds the Z-up -> Y-up
  //    correction into these node rotations, so no extra axis swap is applied here.
  const floors = [];
  for (const node of g.nodes) {
    if (node.mesh == null) continue;
    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    for (const prim of g.meshes[node.mesh].primitives) {
      const P = readAccessor(g, bin, prim.attributes.POSITION);
      const N = readAccessor(g, bin, prim.attributes.NORMAL);
      const U = readAccessor(g, bin, prim.attributes.TEXCOORD_0);
      const I = readAccessor(g, bin, prim.indices);
      const count = P.length / 3;
      const pos = new Float32Array(P.length);
      const nor = new Float32Array(N.length);
      for (let i = 0; i < count; i++) {
        const w = applyTRS([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], t, r, s);
        pos[i * 3] = w[0]; pos[i * 3 + 1] = w[1]; pos[i * 3 + 2] = w[2];
        const nw = rotateVecOnly([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]], r, s);
        const nl = Math.hypot(nw[0], nw[1], nw[2]) || 1;
        nor[i * 3] = nw[0] / nl; nor[i * 3 + 1] = nw[1] / nl; nor[i * 3 + 2] = nw[2] / nl;
      }
      floors.push({ name: node.name, pos, nor, uv: U, idx: I, material: prim.material });
    }
  }

  // 2. Auto-level. The source rip is tilted a couple of degrees off vertical, which a
  //    shooter cannot tolerate (gravity, stair stepping and the minimap all assume +Y up).
  //    Recover the true up axis as the area-weighted mean normal of near-horizontal faces.
  const up = dominantUp(floors);
  log(`dominant up = [${up.map((v) => v.toFixed(4)).join(', ')}] (tilt ${(Math.acos(Math.min(1, up[1])) * 180 / Math.PI).toFixed(2)} deg)`);
  const levelQ = quatFromTo(up, [0, 1, 0]);
  for (const f of floors) rotateBuffers(f, levelQ);

  // 3. Auto-yaw. Snap the dominant wall run to the X axis so chunk grid, minimap and
  //    compass bearings line up with the architecture instead of cutting it diagonally.
  const yaw = dominantYaw(floors);
  log(`dominant yaw = ${(yaw * 180 / Math.PI).toFixed(2)} deg -> snapping to axis`);
  const yawQ = [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)];
  for (const f of floors) rotateBuffers(f, yawQ);

  // 4. Re-centre: ground floor at y = 0, map centred on the XZ origin.
  let gMinY = Infinity, gMaxY = -Infinity, gMinX = Infinity, gMaxX = -Infinity, gMinZ = Infinity, gMaxZ = -Infinity;
  for (const f of floors) for (let i = 0; i < f.pos.length; i += 3) {
    if (f.pos[i] < gMinX) gMinX = f.pos[i]; if (f.pos[i] > gMaxX) gMaxX = f.pos[i];
    if (f.pos[i + 1] < gMinY) gMinY = f.pos[i + 1]; if (f.pos[i + 1] > gMaxY) gMaxY = f.pos[i + 1];
    if (f.pos[i + 2] < gMinZ) gMinZ = f.pos[i + 2]; if (f.pos[i + 2] > gMaxZ) gMaxZ = f.pos[i + 2];
  }
  const cx = (gMinX + gMaxX) / 2, cz = (gMinZ + gMaxZ) / 2;
  log(`footprint ${(gMaxX - gMinX).toFixed(1)} x ${(gMaxZ - gMinZ).toFixed(1)} m, height ${(gMaxY - gMinY).toFixed(1)} m`);
  for (const f of floors) {
    for (let i = 0; i < f.pos.length; i += 3) {
      f.pos[i] -= cx; f.pos[i + 1] -= gMinY; f.pos[i + 2] -= cz;
    }
  }

  // 3. Build the output document.
  await MeshoptEncoder.ready;
  const doc = new Document();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const buffer = doc.createBuffer();
  const scene = doc.createScene('lunapark');

  // Textures: decode source JPEG, clamp size, re-encode as WebP.
  const materials = [];
  for (let mi = 0; mi < g.materials.length; mi++) {
    const src = g.materials[mi];
    const texIdx = src.pbrMetallicRoughness?.baseColorTexture?.index;
    const mat = doc.createMaterial(src.name || `mat${mi}`)
      .setRoughnessFactor(0.92)
      .setMetallicFactor(0.0)
      .setDoubleSided(true);
    if (texIdx != null) {
      // Encoded by tools/textures.mjs in a separate process — see the note there.
      const cached = path.join(ROOT, '.cache', `albedo${g.textures[texIdx].source}.webp`);
      if (!fs.existsSync(cached)) throw new Error(`missing ${cached}; run: node tools/textures.mjs`);
      const webp = fs.readFileSync(cached);
      log(`texture ${mi}: ${(webp.length / 1048576).toFixed(2)} MB webp (cached)`);
      const tex = doc.createTexture(`albedo${mi}`).setImage(webp).setMimeType('image/webp');
      mat.setBaseColorTexture(tex);
      mat.getBaseColorTextureInfo().setWrapS(10497).setWrapT(10497);
    }
    materials.push(mat);
  }

  // Geometry: weld first (the rip is unwelded and faceted), then split into spatial
  // chunks so frustum culling has something to bite on.
  let totalChunks = 0, totalTris = 0;
  for (const f of floors) {
    const w = weldMesh(f.pos, f.uv, f.idx, CREASE_ANGLE);
    log(`${f.name}: weld ${w.stats.before.toLocaleString()} -> ${w.stats.after.toLocaleString()} verts ` +
        `(${(w.stats.before / w.stats.after).toFixed(2)}x), ${w.stats.merged.toLocaleString()} unique pos+uv`);
    f.pos = w.pos; f.nor = w.nor; f.uv = w.uv; f.idx = w.idx;
    const chunks = chunkPrimitive(f.pos, f.nor, f.uv, f.idx, CHUNK);
    const group = doc.createNode(f.name);
    scene.addChild(group);
    for (const c of chunks) {
      if (c.idx.length < 3) continue;
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(c.pos).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(c.nor).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(c.uv).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(c.idx).setBuffer(buffer))
        .setMaterial(materials[f.material]);
      const mesh = doc.createMesh(`${f.name}_${c.key}`).addPrimitive(prim);
      group.addChild(doc.createNode(`${f.name}_${c.key}`).setMesh(mesh));
      totalChunks++; totalTris += c.idx.length / 3;
    }
    log(`${f.name}: ${chunks.length} chunks`);
  }
  log(`total ${totalChunks} chunks, ${totalTris.toLocaleString()} triangles`);

  // 4. Optimise + compress.
  // Quantization budget, sized against a ~56 m map:
  //   position 14 bits -> 3.4 mm, far below anything visible or gameplay-relevant
  //   normal   10 bits -> ~0.35 deg, smooth across the large flat interior surfaces
  //   uv       12 bits -> 1 texel on a 4096 atlas
  await doc.transform(
    weld({ tolerance: 0.0001 }),
    dedup(),
    prune(),
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizationVolume: 'scene',
    }),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );

  fs.mkdirSync(OUT, { recursive: true });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const outFile = path.join(OUT, 'lunapark.glb');
  await io.write(outFile, doc);
  log('wrote', outFile, (fs.statSync(outFile).size / 1048576).toFixed(2), 'MB');

  // 5. Emit a plain-JSON collision + analysis dump for the offline map analyser.
  const dump = { chunk: CHUNK, floors: floors.map((f) => ({ name: f.name, verts: f.pos.length / 3, tris: f.idx.length / 3 })) };
  fs.writeFileSync(path.join(OUT, 'lunapark.meta.json'), JSON.stringify(dump, null, 2));

  // Raw geometry cache for the analyser (not shipped).
  const cacheDir = path.join(ROOT, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const f of floors) {
    fs.writeFileSync(path.join(cacheDir, `${f.name}.pos.bin`), Buffer.from(f.pos.buffer));
    fs.writeFileSync(path.join(cacheDir, `${f.name}.idx.bin`), Buffer.from(new Uint32Array(f.idx).buffer));
    fs.writeFileSync(path.join(cacheDir, `${f.name}.nor.bin`), Buffer.from(f.nor.buffer));
  }
  log('cached raw geometry for analysis');
}

async function buildOperator() {
  const srcFile = path.join(SRC, 'sas_mute_rainbow_six_siege.glb');
  if (!fs.existsSync(srcFile)) { log('operator source missing, skipping'); return; }
  log('reading', srcFile);
  const { json: g, bin } = readGLB(srcFile);

  // Flatten the node hierarchy into world space (Sketchfab exports nest a Z-up correction).
  const world = [];
  const walk = (idx, t, r, s) => {
    const n = g.nodes[idx];
    const nt = n.translation || [0, 0, 0], nr = n.rotation || [0, 0, 0, 1], ns = n.scale || [1, 1, 1];
    // compose parent * local (translation/rotation/uniform-scale only, which is all these files use)
    const wt = applyTRS(nt, t, r, s);
    const wr = mulQuat(r, nr);
    const ws = [s[0] * ns[0], s[1] * ns[1], s[2] * ns[2]];
    if (n.mesh != null) world.push({ mesh: n.mesh, t: wt, r: wr, s: ws });
    for (const c of n.children || []) walk(c, wt, wr, ws);
  };
  for (const root of g.scenes[0].nodes) walk(root, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

  const doc = new Document();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const buffer = doc.createBuffer();
  const scene = doc.createScene('operator');
  const mat = doc.createMaterial('operator_base').setBaseColorFactor([0.30, 0.31, 0.33, 1]).setRoughnessFactor(0.78).setMetallicFactor(0.05);

  let minY = Infinity, maxY = -Infinity;
  const parts = [];
  for (const w of world) {
    for (const prim of g.meshes[w.mesh].primitives) {
      const P = readAccessor(g, bin, prim.attributes.POSITION);
      const N = prim.attributes.NORMAL != null ? readAccessor(g, bin, prim.attributes.NORMAL) : new Float32Array(P.length);
      const I = readAccessor(g, bin, prim.indices);
      const pos = new Float32Array(P.length), nor = new Float32Array(P.length);
      for (let i = 0; i < P.length / 3; i++) {
        const p = applyTRS([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], w.t, w.r, w.s);
        pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
        const nn = rotateVecOnly([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]], w.r, w.s);
        nor[i * 3] = nn[0]; nor[i * 3 + 1] = nn[1]; nor[i * 3 + 2] = nn[2];
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      parts.push({ pos, nor, idx: I });
    }
  }
  // Normalise to 1.80 m tall standing on y = 0.
  const scale = 1.80 / (maxY - minY);
  log(`operator raw height ${(maxY - minY).toFixed(3)} -> scale ${scale.toFixed(4)}`);
  for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) {
    p.pos[i] *= scale; p.pos[i + 1] = (p.pos[i + 1] - minY) * scale; p.pos[i + 2] *= scale;
  }

  const mesh = doc.createMesh('operator');
  for (const p of parts) {
    mesh.addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p.pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(p.nor).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(p.idx)).setBuffer(buffer))
      .setMaterial(mat));
  }
  scene.addChild(doc.createNode('operator').setMesh(mesh));

  await MeshoptEncoder.ready;
  await doc.transform(weld({ tolerance: 0.0002 }), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  fs.mkdirSync(OUT, { recursive: true });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const outFile = path.join(OUT, 'operator.glb');
  await io.write(outFile, doc);
  log('wrote', outFile, (fs.statSync(outFile).size / 1024).toFixed(0), 'KB');
}

function mulQuat(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const which = process.argv[2] || 'all';
if (which === 'all' || which === 'map') await buildMap();
if (which === 'all' || which === 'operator') await buildOperator();
log('done');
