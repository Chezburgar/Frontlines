/**
 * Position/UV welding with crease-aware normal reconstruction.
 *
 * The source map rip ships fully unwelded (3 vertices per triangle, 2.32 M total) with
 * per-face normals, so it renders faceted and compresses badly. gltf-transform v4's weld()
 * is exact-match only and therefore a no-op here.
 *
 * This rebuilds the mesh the way a DCC tool would:
 *   1. merge vertices that share a position and a UV (within a texel),
 *   2. group the faces around each merged vertex into smoothing clusters, splitting wherever
 *      two faces meet at more than `creaseAngle` — so window reveals, door frames and stair
 *      nosings keep their hard edges while walls, vaults and ceilings go smooth,
 *   3. emit one vertex per cluster with an area-weighted average normal.
 *
 * Typical result on this map: 2.32 M -> ~0.48 M vertices, and shading that actually reads
 * as architecture instead of a low-poly facet field.
 */

const POS_SCALE = 8192;   // ~0.12 mm buckets over a 56 m map
const UV_SCALE = 8192;    // one texel on a 4096 atlas

export function weldMesh(pos, uv, idx, creaseAngleDeg = 42) {
  const triCount = idx.length / 3;
  const creaseCos = Math.cos((creaseAngleDeg * Math.PI) / 180);

  // ---- 1. merge by (position, uv) ------------------------------------------
  const keyMap = new Map();
  const baseOf = new Int32Array(idx.length ? pos.length / 3 : 0);
  const basePos = [];
  const baseUV = [];
  for (let v = 0; v < pos.length / 3; v++) {
    const k =
      `${Math.round(pos[v * 3] * POS_SCALE)},${Math.round(pos[v * 3 + 1] * POS_SCALE)},` +
      `${Math.round(pos[v * 3 + 2] * POS_SCALE)},${Math.round(uv[v * 2] * UV_SCALE)},` +
      `${Math.round(uv[v * 2 + 1] * UV_SCALE)}`;
    let b = keyMap.get(k);
    if (b === undefined) {
      b = basePos.length / 3;
      keyMap.set(k, b);
      basePos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      baseUV.push(uv[v * 2], uv[v * 2 + 1]);
    }
    baseOf[v] = b;
  }
  const baseCount = basePos.length / 3;

  // ---- 2. face normals + incidence -----------------------------------------
  const faceN = new Float32Array(triCount * 3);
  const faceArea = new Float32Array(triCount);
  const tri = new Int32Array(triCount * 3);
  const degree = new Uint32Array(baseCount + 1);
  for (let t = 0; t < triCount; t++) {
    const a = baseOf[idx[t * 3]], b = baseOf[idx[t * 3 + 1]], c = baseOf[idx[t * 3 + 2]];
    tri[t * 3] = a; tri[t * 3 + 1] = b; tri[t * 3 + 2] = c;
    const ax = basePos[a * 3], ay = basePos[a * 3 + 1], az = basePos[a * 3 + 2];
    const ux = basePos[b * 3] - ax, uy = basePos[b * 3 + 1] - ay, uz = basePos[b * 3 + 2] - az;
    const vx = basePos[c * 3] - ax, vy = basePos[c * 3 + 1] - ay, vz = basePos[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    faceN[t * 3] = nx; faceN[t * 3 + 1] = ny; faceN[t * 3 + 2] = nz;
    faceArea[t] = len * 0.5;
    degree[a]++; degree[b]++; degree[c]++;
  }

  // CSR adjacency: which faces touch each merged vertex.
  const start = new Uint32Array(baseCount + 1);
  for (let i = 0, run = 0; i <= baseCount; i++) { start[i] = run; run += degree[i] || 0; }
  const cursor = start.slice();
  const inc = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    inc[cursor[tri[t * 3]]++] = t;
    inc[cursor[tri[t * 3 + 1]]++] = t;
    inc[cursor[tri[t * 3 + 2]]++] = t;
  }

  // ---- 3. cluster faces per vertex, emit one output vertex per cluster ------
  const outPos = [], outNor = [], outUV = [];
  // clusterOf[faceSlot] -> output vertex index, indexed the same way as `inc`
  const slotOut = new Int32Array(triCount * 3).fill(-1);
  const cN = [];   // accumulated cluster normals (unnormalised)

  for (let v = 0; v < baseCount; v++) {
    const s = start[v], e = start[v + 1];
    cN.length = 0;
    const clusterIndex = [];
    for (let i = s; i < e; i++) {
      const f = inc[i];
      const fx = faceN[f * 3], fy = faceN[f * 3 + 1], fz = faceN[f * 3 + 2];
      let hit = -1;
      for (let c = 0; c < cN.length; c += 3) {
        const cx = cN[c], cy = cN[c + 1], cz = cN[c + 2];
        const l = Math.hypot(cx, cy, cz) || 1;
        if ((fx * cx + fy * cy + fz * cz) / l >= creaseCos) { hit = c; break; }
      }
      const w = faceArea[f];
      if (hit < 0) {
        hit = cN.length;
        cN.push(fx * w, fy * w, fz * w);
        clusterIndex.push(-1);
      } else {
        cN[hit] += fx * w; cN[hit + 1] += fy * w; cN[hit + 2] += fz * w;
      }
      slotOut[i] = hit / 3;   // temporarily the local cluster id
    }
    // Materialise the clusters as real vertices.
    for (let c = 0; c < cN.length; c += 3) {
      const l = Math.hypot(cN[c], cN[c + 1], cN[c + 2]) || 1;
      clusterIndex[c / 3] = outPos.length / 3;
      outPos.push(basePos[v * 3], basePos[v * 3 + 1], basePos[v * 3 + 2]);
      outNor.push(cN[c] / l, cN[c + 1] / l, cN[c + 2] / l);
      outUV.push(baseUV[v * 2], baseUV[v * 2 + 1]);
    }
    for (let i = s; i < e; i++) slotOut[i] = clusterIndex[slotOut[i]];
  }

  // ---- 4. rebuild the index buffer -----------------------------------------
  // Walk the same CSR order to recover which output vertex each triangle corner became.
  const cur2 = start.slice();
  const outIdx = new Uint32Array(triCount * 3);
  const cornerSlot = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    cornerSlot[t * 3] = cur2[tri[t * 3]]++;
    cornerSlot[t * 3 + 1] = cur2[tri[t * 3 + 1]]++;
    cornerSlot[t * 3 + 2] = cur2[tri[t * 3 + 2]]++;
  }
  for (let i = 0; i < triCount * 3; i++) outIdx[i] = slotOut[cornerSlot[i]];

  return {
    pos: new Float32Array(outPos),
    nor: new Float32Array(outNor),
    uv: new Float32Array(outUV),
    idx: outIdx,
    stats: { before: pos.length / 3, merged: baseCount, after: outPos.length / 3 },
  };
}
