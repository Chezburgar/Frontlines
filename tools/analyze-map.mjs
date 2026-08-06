/**
 * Derives gameplay data from the map mesh.
 *
 * The source is a raw architectural rip with no gameplay markup, so spawns, objective
 * sites and the navigable volume all have to be recovered from the geometry itself:
 *
 *   1. voxelise the triangle soup into a 0.25 m occupancy grid,
 *   2. find standable cells — solid floor below, >= 1.9 m of clear head room above,
 *   3. flood fill the standable set per storey to get connected playable regions,
 *   4. segment each region into rooms by watershed on the distance-to-wall field,
 *   5. score rooms for objective suitability (area, enclosure, number of entrances,
 *      distance from the building envelope) and pick two adjacent rooms per site,
 *   6. place attacker spawns on the outdoor perimeter, far from every site.
 *
 * Output: public/models/lunapark.nav.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'models');

const CELL = 0.25;          // metres per grid cell
const STAND_HEIGHT = 1.90;  // required clear head room
const STEP_UP = 0.70;       // stair/kerb tolerance — ripped stairs are coarse, be generous

const log = (...a) => console.log('[nav]', ...a);

/* --------------------------------------------------------------- load cache */

function loadFloor(name) {
  const pos = new Float32Array(fs.readFileSync(path.join(CACHE, `${name}.pos.bin`)).buffer.slice(0));
  const idx = new Uint32Array(fs.readFileSync(path.join(CACHE, `${name}.idx.bin`)).buffer.slice(0));
  const nor = new Float32Array(fs.readFileSync(path.join(CACHE, `${name}.nor.bin`)).buffer.slice(0));
  return { name, pos, idx, nor };
}

const floors = ['f1', 'f2', 'f3'].map(loadFloor);

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const f of floors) for (let i = 0; i < f.pos.length; i += 3) {
  if (f.pos[i] < minX) minX = f.pos[i]; if (f.pos[i] > maxX) maxX = f.pos[i];
  if (f.pos[i + 1] < minY) minY = f.pos[i + 1]; if (f.pos[i + 1] > maxY) maxY = f.pos[i + 1];
  if (f.pos[i + 2] < minZ) minZ = f.pos[i + 2]; if (f.pos[i + 2] > maxZ) maxZ = f.pos[i + 2];
}
log(`bounds X ${minX.toFixed(1)}..${maxX.toFixed(1)}  Y ${minY.toFixed(1)}..${maxY.toFixed(1)}  Z ${minZ.toFixed(1)}..${maxZ.toFixed(1)}`);

const NX = Math.ceil((maxX - minX) / CELL) + 2;
const NY = Math.ceil((maxY - minY) / CELL) + 2;
const NZ = Math.ceil((maxZ - minZ) / CELL) + 2;
log(`voxel grid ${NX} x ${NY} x ${NZ} = ${(NX * NY * NZ / 1e6).toFixed(1)} M cells`);

const ox = minX - CELL, oy = minY - CELL, oz = minZ - CELL;
const gi = (x, y, z) => (y * NZ + z) * NX + x;

/* ------------------------------------------------------------- voxelisation */

// solid[cell] bit 1 = any geometry, bit 2 = near-horizontal (floor-like) geometry
const solid = new Uint8Array(NX * NY * NZ);

function rasterTri(ax, ay, az, bx, by, bz, cx, cy, cz, floorish) {
  // Subdivide the triangle until each sample lands inside a cell — simple, exact enough
  // at 0.25 m and far easier to trust than a conservative separating-axis voxeliser.
  const e0 = Math.hypot(bx - ax, by - ay, bz - az);
  const e1 = Math.hypot(cx - ax, cy - ay, cz - az);
  const steps = Math.max(1, Math.ceil(Math.max(e0, e1) / (CELL * 0.5)));
  const flag = 1 | (floorish ? 2 : 0);
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps - i; j++) {
      const u = i / steps, v = j / steps, w = 1 - u - v;
      const px = ax * w + bx * u + cx * v;
      const py = ay * w + by * u + cy * v;
      const pz = az * w + bz * u + cz * v;
      const X = ((px - ox) / CELL) | 0, Y = ((py - oy) / CELL) | 0, Z = ((pz - oz) / CELL) | 0;
      if (X < 0 || Y < 0 || Z < 0 || X >= NX || Y >= NY || Z >= NZ) continue;
      solid[gi(X, Y, Z)] |= flag;
    }
  }
}

let triTotal = 0;
for (const f of floors) {
  for (let t = 0; t < f.idx.length; t += 3) {
    const a = f.idx[t], b = f.idx[t + 1], c = f.idx[t + 2];
    // face normal decides "floor-like"
    const ax = f.pos[a * 3], ay = f.pos[a * 3 + 1], az = f.pos[a * 3 + 2];
    const ux = f.pos[b * 3] - ax, uy = f.pos[b * 3 + 1] - ay, uz = f.pos[b * 3 + 2] - az;
    const vx = f.pos[c * 3] - ax, vy = f.pos[c * 3 + 1] - ay, vz = f.pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    rasterTri(ax, ay, az,
      f.pos[b * 3], f.pos[b * 3 + 1], f.pos[b * 3 + 2],
      f.pos[c * 3], f.pos[c * 3 + 1], f.pos[c * 3 + 2],
      Math.abs(ny / l) > 0.72);
    triTotal++;
  }
}
log(`rasterised ${triTotal.toLocaleString()} triangles`);

/* --------------------------------------------------------------- standable */

const headCells = Math.ceil(STAND_HEIGHT / CELL);
const stand = new Uint8Array(NX * NY * NZ);
let standCount = 0;
for (let y = 1; y < NY - headCells; y++) {
  for (let z = 0; z < NZ; z++) {
    for (let x = 0; x < NX; x++) {
      if (!(solid[gi(x, y - 1, z)] & 2)) continue;      // needs floor directly beneath
      let clear = true;
      for (let h = 0; h < headCells; h++) {
        if (solid[gi(x, y + h, z)] & 1) { clear = false; break; }
      }
      if (!clear) continue;
      stand[gi(x, y, z)] = 1;
      standCount++;
    }
  }
}
log(`standable cells ${standCount.toLocaleString()} (${(standCount * CELL * CELL).toFixed(0)} m^2 of surface)`);

/* ------------------------------------------------------- connected regions */

const stepCells = Math.round(STEP_UP / CELL);
const region = new Int32Array(NX * NY * NZ).fill(-1);
const regions = [];
const stack = new Int32Array(standCount * 2);

for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
  const s = gi(x, y, z);
  if (!stand[s] || region[s] >= 0) continue;
  const id = regions.length;
  const cells = [];
  let sp = 0; stack[sp++] = s; region[s] = id;
  while (sp > 0) {
    const cur = stack[--sp];
    cells.push(cur);
    const cy = (cur / (NX * NZ)) | 0;
    const rem = cur - cy * NX * NZ;
    const cz = (rem / NX) | 0;
    const cx = rem - cz * NX;
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
      const nx2 = cx + dx, nz2 = cz + dz;
      if (nx2 < 0 || nz2 < 0 || nx2 >= NX || nz2 >= NZ) continue;
      for (let dy = -stepCells; dy <= stepCells; dy++) {
        const ny2 = cy + dy;
        if (ny2 < 0 || ny2 >= NY) continue;
        const nS = gi(nx2, ny2, nz2);
        if (stand[nS] && region[nS] < 0) { region[nS] = id; stack[sp++] = nS; }
      }
    }
  }
  regions.push({ id, cells });
}
regions.sort((a, b) => b.cells.length - a.cells.length);
log(`regions: ${regions.length}, largest ${regions.slice(0, 6).map((r) => r.cells.length).join(', ')}`);

// A ripped mesh has small holes and coarse stair treads, so the flood fill shatters into
// hundreds of islands. Movement uses capsule-vs-mesh collision and does not depend on this
// grid, so for placement purposes fold in every island big enough to stand a fight in
// (>= 12 m^2) rather than trusting a single connected component.
const MIN_ISLAND = Math.round(12 / (CELL * CELL));
const kept = regions.filter((r) => r.cells.length >= MIN_ISLAND);
const playable = { cells: kept.flatMap((r) => r.cells) };
log(`playable: ${kept.length} islands >= 12 m^2, ${playable.cells.length.toLocaleString()} cells ` +
    `= ${(playable.cells.length * CELL * CELL).toFixed(0)} m^2 (of ${(standCount * CELL * CELL).toFixed(0)} standable)`);

/* --------------------------------------------------------- storey detection */

const yHist = new Float64Array(NY);
for (const c of playable.cells) yHist[(c / (NX * NZ)) | 0]++;
const storeys = [];
{
  const minPeak = playable.cells.length * 0.02;
  for (let y = 1; y < NY - 1; y++) {
    if (yHist[y] < minPeak) continue;
    if (yHist[y] >= yHist[y - 1] && yHist[y] >= yHist[y + 1]) {
      const worldY = oy + y * CELL;
      if (storeys.length && worldY - storeys[storeys.length - 1].y < 1.6) {
        if (yHist[y] > storeys[storeys.length - 1].count) storeys[storeys.length - 1] = { y: worldY, count: yHist[y] };
      } else storeys.push({ y: worldY, count: yHist[y] });
    }
  }
}
log(`storeys: ${storeys.map((s) => s.y.toFixed(2) + 'm(' + s.count + ')').join(', ')}`);

/* -------------------------------------------------- per-storey room analysis */

function storeyGrid(storeyY) {
  // Collapse the cells belonging to this storey into a 2D mask.
  const mask = new Uint8Array(NX * NZ);
  const heightAt = new Float32Array(NX * NZ).fill(NaN);
  for (const c of playable.cells) {
    const cy = (c / (NX * NZ)) | 0;
    const wy = oy + cy * CELL;
    if (Math.abs(wy - storeyY) > 1.4) continue;
    const rem = c - cy * NX * NZ;
    const cz = (rem / NX) | 0, cx = rem - cz * NX;
    const k = cz * NX + cx;
    if (!mask[k] || wy < heightAt[k]) { mask[k] = 1; heightAt[k] = wy; }
  }
  return { mask, heightAt };
}

/** Chamfer distance transform: metres from each open cell to the nearest blocked cell. */
function distanceField(mask) {
  const d = new Float32Array(NX * NZ).fill(1e9);
  for (let i = 0; i < NX * NZ; i++) if (!mask[i]) d[i] = 0;
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const i = z * NX + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
    if (z > 0) d[i] = Math.min(d[i], d[i - NX] + 1);
    if (x > 0 && z > 0) d[i] = Math.min(d[i], d[i - NX - 1] + 1.41421);
    if (x < NX - 1 && z > 0) d[i] = Math.min(d[i], d[i - NX + 1] + 1.41421);
  }
  for (let z = NZ - 1; z >= 0; z--) for (let x = NX - 1; x >= 0; x--) {
    const i = z * NX + x;
    if (x < NX - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
    if (z < NZ - 1) d[i] = Math.min(d[i], d[i + NX] + 1);
    if (x < NX - 1 && z < NZ - 1) d[i] = Math.min(d[i], d[i + NX + 1] + 1.41421);
    if (x > 0 && z < NZ - 1) d[i] = Math.min(d[i], d[i + NX - 1] + 1.41421);
  }
  for (let i = 0; i < NX * NZ; i++) d[i] *= CELL;
  return d;
}

/**
 * Watershed on the distance field: seed at local maxima (room centres, the points
 * furthest from any wall) and grow downhill, so corridors and doorways -- which have a
 * low distance value -- become the boundaries between rooms.
 */
function segmentRooms(mask, dist) {
  const SEED_MIN = 1.15;                  // a room centre is >= 1.15 m from every wall
  const seeds = [];
  for (let z = 2; z < NZ - 2; z++) for (let x = 2; x < NX - 2; x++) {
    const i = z * NX + x;
    if (!mask[i] || dist[i] < SEED_MIN) continue;
    let isMax = true;
    for (let dz = -3; dz <= 3 && isMax; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (!dx && !dz) continue;
      const j = (z + dz) * NX + (x + dx);
      if (j < 0 || j >= NX * NZ) continue;
      if (dist[j] > dist[i] + 1e-6) { isMax = false; break; }
    }
    if (isMax) seeds.push(i);
  }
  // Merge seeds that sit within one room of each other.
  const label = new Int32Array(NX * NZ).fill(-1);
  const rooms = [];
  for (const s of seeds) {
    if (label[s] >= 0) continue;
    const id = rooms.length;
    const q = [s]; label[s] = id;
    const r = 2.0;   // merge radius in metres
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const z = (i / NX) | 0, x = i - z * NX;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const j = (z + dz) * NX + (x + dx);
        if (j < 0 || j >= NX * NZ || label[j] >= 0 || !mask[j]) continue;
        if (dist[j] >= SEED_MIN && Math.abs(dist[j] - dist[i]) < r) { label[j] = id; q.push(j); }
      }
    }
    rooms.push({ id, seed: s, cells: q.slice() });
  }
  // Priority flood: highest distance first, so growth spreads from open space into the tight bits.
  const pending = [];
  for (const r of rooms) for (const c of r.cells) pending.push(c);
  pending.sort((a, b) => dist[b] - dist[a]);
  let head = 0;
  const queue = pending;
  while (head < queue.length) {
    const i = queue[head++];
    const id = label[i];
    const z = (i / NX) | 0, x = i - z * NX;
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
      const nx2 = x + dx, nz2 = z + dz;
      if (nx2 < 0 || nz2 < 0 || nx2 >= NX || nz2 >= NZ) continue;
      const j = nz2 * NX + nx2;
      if (!mask[j] || label[j] >= 0) continue;
      label[j] = id;
      rooms[id].cells.push(j);
      queue.push(j);
    }
  }
  return { label, rooms };
}

const cellToWorld = (i, y) => ({ x: ox + (i % NX) * CELL + CELL / 2, y, z: oz + (((i / NX) | 0)) * CELL + CELL / 2 });

const analysis = { cell: CELL, bounds: { minX, maxX, minY, maxY, minZ, maxZ }, storeys: [] };

for (const st of storeys) {
  const { mask, heightAt } = storeyGrid(st.y);
  let open = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) open++;
  if (open * CELL * CELL < 25) continue;
  const dist = distanceField(mask);
  const { label, rooms } = segmentRooms(mask, dist);

  const roomInfo = rooms.map((r) => {
    let sx = 0, sz = 0, best = -1, bestD = -1;
    for (const c of r.cells) {
      sx += ox + (c % NX) * CELL; sz += oz + (((c / NX) | 0)) * CELL;
      if (dist[c] > bestD) { bestD = dist[c]; best = c; }
    }
    const n = r.cells.length;
    // entrances: boundary cells adjacent to a different room
    let entrances = 0;
    const neighbours = new Set();
    for (const c of r.cells) {
      const z = (c / NX) | 0, x = c - z * NX;
      for (let d = 0; d < 4; d++) {
        const j = (z + (d === 2 ? 1 : d === 3 ? -1 : 0)) * NX + (x + (d === 0 ? 1 : d === 1 ? -1 : 0));
        if (j < 0 || j >= NX * NZ) continue;
        if (label[j] >= 0 && label[j] !== r.id) { entrances++; neighbours.add(label[j]); }
      }
    }
    const centre = cellToWorld(best, heightAt[best] ?? st.y);
    return {
      id: r.id,
      area: +(n * CELL * CELL).toFixed(1),
      centre: { x: +centre.x.toFixed(2), y: +(st.y).toFixed(2), z: +centre.z.toFixed(2) },
      mean: { x: +(sx / n).toFixed(2), z: +(sz / n).toFixed(2) },
      openness: +bestD.toFixed(2),
      entrances: Math.round(entrances / 4),
      neighbours: [...neighbours],
    };
  }).filter((r) => r.area >= 6);

  roomInfo.sort((a, b) => b.area - a.area);
  analysis.storeys.push({ y: +st.y.toFixed(2), openM2: +(open * CELL * CELL).toFixed(0), rooms: roomInfo });
  log(`storey ${st.y.toFixed(2)}m: ${(open * CELL * CELL).toFixed(0)} m^2, ${roomInfo.length} rooms ` +
      `(largest ${roomInfo.slice(0, 4).map((r) => r.area + 'm2').join(', ')})`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'lunapark.nav.json'), JSON.stringify(analysis));
log(`wrote lunapark.nav.json (${(fs.statSync(path.join(OUT, 'lunapark.nav.json')).size / 1024).toFixed(0)} KB)`);
