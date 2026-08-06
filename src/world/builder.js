/**
 * Architectural geometry builder.
 *
 * Turns a declarative blueprint into geometry. The unit of construction is a wall segment
 * with openings punched through it — every door, window, arch, murder hole and blown
 * breach in the map is one of these, which is what keeps the layout consistent: a window
 * sill is always the same height, a door always fits a player, and every opening the
 * builder creates is automatically a real hole in the collision mesh too.
 *
 * Surfaces marked destructible are emitted as separate meshes so they can be removed,
 * holed or reinforced at runtime without touching the static geometry around them.
 */
import * as THREE from 'three';
import { MaterialLibrary, BREAK } from './materials.js';

/* Standard dimensions — a single source of truth keeps sightlines predictable. */
export const DIM = {
  wallThick: 0.18,
  partitionThick: 0.10,
  doorW: 1.10,
  doorH: 2.05,
  windowSill: 0.95,
  windowHead: 2.20,
  shojiH: 2.05,           // full shoji screens run floor to lintel
  hatchSize: 1.20,
  railH: 1.05,
  storeyH: 3.30,
  /** Crouched eye height — openings below this are peek-only, above are full-body. */
  crouchEye: 1.05,
  standEye: 1.63,
};

let __id = 0;
const nextId = () => `s${(++__id).toString(36)}`;

/**
 * One buildable surface. Static geometry is merged for draw-call efficiency; anything
 * destructible or interactive stays a standalone mesh.
 */
export class SurfacePiece {
  constructor(mesh, { surface, breakClass, reinforceable, room, kind }) {
    this.id = nextId();
    this.mesh = mesh;
    this.surface = surface;
    this.breakClass = breakClass ?? BREAK.NONE;
    this.reinforceable = !!reinforceable;
    this.room = room ?? null;
    this.kind = kind ?? 'wall';
    this.health = breakClass === BREAK.SOFT ? 1
      : breakClass === BREAK.PLASTER ? 260
      : breakClass === BREAK.WOOD ? 420 : Infinity;
    this.maxHealth = this.health;
    this.reinforced = false;
    this.destroyed = false;
    this.holes = [];
    mesh.userData.piece = this;
  }
}

export class MapBuilder {
  /**
   * Geometry problems found during construction. Collected rather than thrown so one bad
   * opening does not abort the whole map, and surfaced in the console at load.
   */
  static issues = [];

  /**
   * @param {MaterialLibrary} lib
   */
  constructor(lib) {
    this.lib = lib;
    this.root = new THREE.Group();
    this.root.name = 'teahouse';

    this.staticGroup = new THREE.Group(); this.staticGroup.name = 'static';
    this.dynamicGroup = new THREE.Group(); this.dynamicGroup.name = 'destructible';
    this.propGroup = new THREE.Group(); this.propGroup.name = 'props';
    this.root.add(this.staticGroup, this.dynamicGroup, this.propGroup);

    /** Static geometry accumulated per material, merged at the end. */
    this._batches = new Map();
    this.pieces = [];
    this.rooms = [];
    this.spawns = { attack: [], defend: [] };
    this.objectives = [];
    this.hatches = [];
    this.lights = [];
    this.ladders = [];
  }

  /* ------------------------------------------------------------ primitives */

  /**
   * Queues a box into the static batch for `matName`.
   * UVs are scaled by world size so texture density is uniform across the whole map
   * regardless of how large the individual box is.
   */
  box(cx, cy, cz, sx, sy, sz, matName, opts = {}) {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    this._scaleBoxUVs(geo, sx, sy, sz, opts.texelScale ?? 0.35);
    geo.translate(cx, cy, cz);
    if (opts.standalone) {
      const mesh = new THREE.Mesh(geo, opts.material ?? this.lib.get(matName));
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = true;
      return mesh;
    }
    this._push(matName, geo);
    return null;
  }

  /**
   * Box UVs default to a 0..1 square per face, which stretches a 6 m wall's texture over
   * the same span as a 0.2 m sill. Rewriting them in world units fixes texture density
   * everywhere at once.
   */
  _scaleBoxUVs(geo, sx, sy, sz, scale) {
    const uv = geo.attributes.uv;
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (4 verts each)
    const spans = [
      [sz, sy], [sz, sy],
      [sx, sz], [sx, sz],
      [sx, sy], [sx, sy],
    ];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, uv.getX(i) * spans[f][0] * scale, uv.getY(i) * spans[f][1] * scale);
      }
    }
    uv.needsUpdate = true;
  }

  _push(matName, geo) {
    if (!this._batches.has(matName)) this._batches.set(matName, []);
    this._batches.get(matName).push(geo);
  }

  /* ----------------------------------------------------------------- walls */

  /**
   * A wall from (x1,z1) to (x2,z2).
   *
   * `openings` are placed along the wall's length in metres from its start:
   *   { at, w, sill, head, kind }
   * where kind is 'door' | 'window' | 'arch' | 'murderhole' | 'open'.
   *
   * `panels` marks spans that should be built as destructible standalone pieces instead of
   * merged static geometry — this is how a room gets a breachable wall without making the
   * whole wall dynamic.
   */
  wall(x1, z1, x2, z2, opts = {}) {
    const {
      mat = 'plaster',
      thick = DIM.wallThick,
      base = 0,
      height = DIM.storeyH,
      openings = [],
      breakClass = null,
      reinforceable = false,
      room = null,
      trim = true,
    } = opts;

    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const ang = Math.atan2(dz, dx);
    const ux = dx / len, uz = dz / len;

    (this._wallSegs ??= []).push({ x1, z1, x2, z2, base, thick });

    // Validate openings before building. An opening that overlaps its neighbour or runs
    // off the end of the wall still gets a full timber frame drawn around it, which is
    // what produces the floating/interpenetrating frames seen in-game — the wall segment
    // that should have surrounded it was never emitted.
    const sorted = [...openings].sort((a, b) => a.at - b.at).filter((o) => {
      const w = o.w ?? DIM.doorW;
      const a0 = o.at - w / 2, a1 = o.at + w / 2;
      if (a0 < -1e-3 || a1 > len + 1e-3) {
        MapBuilder.issues.push(
          `opening ${o.kind ?? 'open'} at ${o.at.toFixed(2)} (w ${w}) exceeds wall ` +
          `(${x1},${z1})-(${x2},${z2}) of length ${len.toFixed(2)}`);
        return false;
      }
      return true;
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const prevEnd = prev.at + (prev.w ?? DIM.doorW) / 2;
      const curStart = cur.at - (cur.w ?? DIM.doorW) / 2;
      if (curStart < prevEnd - 1e-3) {
        MapBuilder.issues.push(
          `openings overlap on wall (${x1},${z1})-(${x2},${z2}): ` +
          `${prev.kind ?? 'open'}@${prev.at} ends ${prevEnd.toFixed(2)}, ` +
          `${cur.kind ?? 'open'}@${cur.at} starts ${curStart.toFixed(2)}`);
      }
    }
    const segments = [];
    let cursor = 0;

    for (const o of sorted) {
      const w = o.w ?? DIM.doorW;
      const sill = o.sill ?? (o.kind === 'window' ? DIM.windowSill
        : o.kind === 'murderhole' ? 0.28 : 0);
      const head = o.head ?? (o.kind === 'window' ? DIM.windowHead
        : o.kind === 'murderhole' ? 0.62
        : o.kind === 'arch' ? height
        : DIM.doorH);
      const start = o.at - w / 2;
      if (start > cursor + 0.01) segments.push({ u0: cursor, u1: start, y0: 0, y1: height });
      // Below the opening (sill wall) and above it (lintel).
      if (sill > 0.01) segments.push({ u0: start, u1: start + w, y0: 0, y1: sill, spandrel: true });
      if (head < height - 0.01) segments.push({ u0: start, u1: start + w, y0: head, y1: height, spandrel: true });
      cursor = start + w;
      if (o.kind !== 'open') {
        this._openingTrim(x1, z1, ux, uz, ang, o.at, w, sill, head, thick, trim, o, base);
      }
    }
    if (cursor < len - 0.01) segments.push({ u0: cursor, u1: len, y0: 0, y1: height });

    // Emit the spans.
    for (const s of segments) {
      const w = s.u1 - s.u0;
      const h = s.y1 - s.y0;
      if (w < 0.02 || h < 0.02) continue;
      const mu = (s.u0 + s.u1) / 2;
      const cx = x1 + ux * mu, cz = z1 + uz * mu;
      const cy = base + (s.y0 + s.y1) / 2;

      const geo = new THREE.BoxGeometry(w, h, thick);
      this._scaleBoxUVs(geo, w, h, thick, 0.55);
      geo.rotateY(-ang);
      geo.translate(cx, cy, cz);

      if (breakClass && breakClass !== BREAK.NONE && !s.spandrel) {
        const mesh = new THREE.Mesh(geo, this.lib.cloneFor(mat));
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.dynamicGroup.add(mesh);
        const piece = new SurfacePiece(mesh, {
          surface: mat, breakClass, reinforceable, room, kind: 'wall',
        });
        piece.span = { x1: cx - ux * w / 2, z1: cz - uz * w / 2, x2: cx + ux * w / 2, z2: cz + uz * w / 2, h, base: base + s.y0 };
        this.pieces.push(piece);
      } else {
        this._push(mat, geo);
      }
    }
  }

  /** Frames an opening with timber, which is what sells a doorway as built rather than cut. */
  _openingTrim(x1, z1, ux, uz, ang, at, w, sill, head, thick, enabled, o, base = 0) {
    if (!enabled) return;
    const t = 0.07;
    const frameMat = 'woodBeam';
    const cx = x1 + ux * at, cz = z1 + uz * at;

    // Record the frame volume so overlapping frames can be detected regardless of the
    // orientation of the walls they belong to — the parallel-wall check misses two
    // openings colliding at a corner or across perpendicular walls.
    const halfW = w / 2 + t;
    const ax = Math.abs(ux) * halfW + Math.abs(uz) * (thick / 2 + 0.05);
    const az = Math.abs(uz) * halfW + Math.abs(ux) * (thick / 2 + 0.05);
    (this._openingBoxes ??= []).push({
      kind: o.kind ?? 'open',
      minX: cx - ax, maxX: cx + ax,
      minZ: cz - az, maxZ: cz + az,
      minY: base + sill - t, maxY: base + head + t,
      cx, cz, at,
    });

    // `sill` and `head` are heights above the wall's own base, so every Y here has to be
    // offset by it. Without that, first-storey window frames were all drawn down at
    // ground-floor height, floating over the openings below them.
    const addLocal = (du, dy, sw, sh, sd) => {
      const geo = new THREE.BoxGeometry(sw, sh, sd);
      this._scaleBoxUVs(geo, sw, sh, sd, 1.4);
      geo.rotateY(-ang);
      geo.translate(cx + ux * du, base + dy, cz + uz * du);
      this._push(frameMat, geo);
    };
    // jambs
    addLocal(-w / 2 - t / 2, (sill + head) / 2, t, head - sill, thick + 0.02);
    addLocal(w / 2 + t / 2, (sill + head) / 2, t, head - sill, thick + 0.02);
    // lintel
    addLocal(0, head + t / 2, w + t * 2, t, thick + 0.02);
    // sill for windows
    if (sill > 0.05) addLocal(0, sill - t / 2, w + t * 2, t, thick + 0.06);

    // Shoji screens fill their opening with a translucent panel that is itself destructible.
    if (o.screen) {
      const geo = new THREE.BoxGeometry(w, head - sill, 0.03);
      this._scaleBoxUVs(geo, w, head - sill, 0.03, 0.5);
      geo.rotateY(-ang);
      geo.translate(cx, base + (sill + head) / 2, cz);
      const mesh = new THREE.Mesh(geo, this.lib.cloneFor(o.screen));
      mesh.castShadow = false; mesh.receiveShadow = true;
      this.dynamicGroup.add(mesh);
      const piece = new SurfacePiece(mesh, {
        surface: o.screen, breakClass: BREAK.SOFT, reinforceable: false, kind: 'screen',
      });
      this.pieces.push(piece);
    }

    // Barricadeable openings record their frame so planks can be spawned into it later.
    if (o.barricadeable) {
      this.barricades = this.barricades || [];
      this.barricades.push({
        id: nextId(), x: cx, z: cz, angle: ang, width: w,
        sill: base + sill, head: base + head, base,
        kind: o.kind, planks: [], intact: false,
      });
    }
  }

  /* ---------------------------------------------------------------- floors */

  /**
   * A floor slab plus the ceiling of the storey below it. `holes` cut stair wells,
   * courtyards and hatch openings.
   */
  slab(x1, z1, x2, z2, y, opts = {}) {
    const { mat = 'woodFloor', thick = 0.22, holes = [], ceiling = null, room = null } = opts;
    const rects = subtractRects([x1, z1, x2, z2], holes);
    for (const r of rects) {
      const w = r[2] - r[0], d = r[3] - r[1];
      if (w < 0.02 || d < 0.02) continue;
      this.box((r[0] + r[2]) / 2, y - thick / 2, (r[1] + r[3]) / 2, w, thick, d, mat);
      if (ceiling) {
        this.box((r[0] + r[2]) / 2, y - thick - 0.02, (r[1] + r[3]) / 2, w, 0.04, d, ceiling);
      }
    }
    if (room) this.rooms.push({ ...room, rect: [x1, z1, x2, z2], y });
  }

  /**
   * A destructible hatch in a floor — the vertical rotation Siege runs on. Built as a
   * standalone piece so blowing it opens a real hole between storeys.
   */
  hatch(cx, cz, y, size = DIM.hatchSize) {
    const geo = new THREE.BoxGeometry(size, 0.16, size);
    this._scaleBoxUVs(geo, size, 0.16, size, 0.8);
    geo.translate(cx, y - 0.08, cz);
    const mesh = new THREE.Mesh(geo, this.lib.cloneFor('woodFloor'));
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.dynamicGroup.add(mesh);
    const piece = new SurfacePiece(mesh, {
      surface: 'woodFloor', breakClass: BREAK.WOOD, reinforceable: true, kind: 'hatch',
    });
    piece.hatch = { x: cx, z: cz, y, size };
    this.pieces.push(piece);
    this.hatches.push(piece);
    return piece;
  }

  /** Straight run of stairs with a timber balustrade. */
  stairs(x1, z1, x2, z2, yBase, yTop, width, opts = {}) {
    const { mat = 'woodFloor', rail = true } = opts;
    const dx = x2 - x1, dz = z2 - z1;
    const run = Math.hypot(dx, dz);
    const ux = dx / run, uz = dz / run;
    const ang = Math.atan2(dz, dx);
    const rise = yTop - yBase;
    const steps = Math.max(6, Math.round(rise / 0.185));
    const stepRise = rise / steps;
    const stepRun = run / steps;

    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) * stepRun;
      const cx = x1 + ux * u, cz = z1 + uz * u;
      const h = yBase + (i + 1) * stepRise;
      // Each tread is a solid block down to the previous step, so collision is a clean ramp.
      const geo = new THREE.BoxGeometry(stepRun, stepRise, width);
      this._scaleBoxUVs(geo, stepRun, stepRise, width, 1.0);
      geo.rotateY(-ang);
      geo.translate(cx, h - stepRise / 2, cz);
      this._push(mat, geo);
    }
    if (rail) {
      for (const side of [-1, 1]) {
        const ox = -uz * (width / 2) * side, oz = ux * (width / 2) * side;
        const geo = new THREE.BoxGeometry(run, 0.08, 0.08);
        this._scaleBoxUVs(geo, run, 0.08, 0.08, 1.6);
        geo.rotateZ(Math.atan2(rise, run));
        geo.rotateY(-ang);
        geo.translate(x1 + ux * run / 2 + ox, yBase + rise / 2 + DIM.railH, z1 + uz * run / 2 + oz);
        this._push('woodBeam', geo);
      }
    }
  }

  /** Structural post — the visual rhythm of the whole building, and useful hard cover. */
  post(x, z, yBase, height, size = 0.19) {
    this.box(x, yBase + height / 2, z, size, height, size, 'woodBeam', { texelScale: 1.2 });
  }

  /* --------------------------------------------------------------- finalise */

  /**
   * Merges every static batch into one mesh per material and returns the root.
   * Static geometry is ~1 draw call per surface type; everything interactive stays split.
   */
  /**
   * Flags walls that occupy the same space.
   *
   * Two near-parallel walls a few centimetres apart are almost always an authoring
   * mistake — they z-fight, they double up door frames, and they produce a sliver of
   * unreachable space between them. Cheap to check at ~60 walls and it catches the whole
   * class rather than the one instance someone happened to screenshot.
   */
  _checkWallOverlaps() {
    const segs = this._wallSegs ?? [];
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if (Math.abs(a.base - b.base) > 1.0) continue;          // different storeys
        const da = { x: a.x2 - a.x1, z: a.z2 - a.z1 };
        const db = { x: b.x2 - b.x1, z: b.z2 - b.z1 };
        const la = Math.hypot(da.x, da.z), lb = Math.hypot(db.x, db.z);
        if (la < 0.5 || lb < 0.5) continue;
        // Parallel?
        const cross = Math.abs((da.x * db.z - da.z * db.x) / (la * lb));
        if (cross > 0.08) continue;
        // Perpendicular distance between the two lines.
        const nx = -da.z / la, nz = da.x / la;
        const gap = Math.abs((b.x1 - a.x1) * nx + (b.z1 - a.z1) * nz);
        if (gap > 0.62) continue;
        // Do they actually overlap along their shared axis?
        const ux = da.x / la, uz = da.z / la;
        const proj = (x, z) => (x - a.x1) * ux + (z - a.z1) * uz;
        const b0 = Math.min(proj(b.x1, b.z1), proj(b.x2, b.z2));
        const b1 = Math.max(proj(b.x1, b.z1), proj(b.x2, b.z2));
        const overlap = Math.min(la, b1) - Math.max(0, b0);
        if (overlap < 0.6) continue;
        MapBuilder.issues.push(
          `walls overlap: (${a.x1},${a.z1})-(${a.x2},${a.z2}) and ` +
          `(${b.x1},${b.z1})-(${b.x2},${b.z2}); gap ${gap.toFixed(2)} m over ${overlap.toFixed(1)} m`);
      }
    }
  }

  /**
   * Flags opening frames whose volumes intersect.
   *
   * This catches what the parallel-wall check cannot: a window on one wall colliding with
   * a door on a perpendicular wall, or two openings from different walls meeting at a
   * corner. It tests the symptom the player actually sees — two timber frames occupying
   * the same space — rather than inferring it from wall placement.
   */
  _checkOpeningOverlaps() {
    const boxes = this._openingBoxes ?? [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        if (ox > 0.02 && oy > 0.02 && oz > 0.02) {
          MapBuilder.issues.push(
            `opening frames intersect: ${a.kind} at (${a.cx.toFixed(2)}, ${a.cz.toFixed(2)}) ` +
            `and ${b.kind} at (${b.cx.toFixed(2)}, ${b.cz.toFixed(2)}) ` +
            `- overlap ${ox.toFixed(2)} x ${oy.toFixed(2)} x ${oz.toFixed(2)} m`);
        }
      }
    }
  }

  finalise() {
    this._checkWallOverlaps();
    this._checkOpeningOverlaps();
    for (const [matName, geos] of this._batches) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, this.lib.get(matName));
      mesh.name = `static_${matName}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.staticGroup.add(mesh);
    }
    this._batches.clear();
    return this.root;
  }
}

/* ------------------------------------------------------------------ helpers */

/** Merges BufferGeometries that share an attribute layout (position/normal/uv). */
export function mergeGeometries(geos) {
  let vTotal = 0, iTotal = 0;
  for (const g of geos) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (t) uv.set(t.array, vo * 2);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Rectangle subtraction on the XZ plane — used to cut courtyards, stair wells and hatch
 * openings out of floor slabs. Returns a set of rectangles covering the remainder.
 */
export function subtractRects(rect, holes) {
  let parts = [rect];
  for (const h of holes) {
    const next = [];
    for (const r of parts) {
      // No overlap: keep whole.
      if (h[2] <= r[0] || h[0] >= r[2] || h[3] <= r[1] || h[1] >= r[3]) { next.push(r); continue; }
      const x0 = Math.max(r[0], h[0]), x1 = Math.min(r[2], h[2]);
      const z0 = Math.max(r[1], h[1]), z1 = Math.min(r[3], h[3]);
      if (r[1] < z0) next.push([r[0], r[1], r[2], z0]);      // north strip
      if (z1 < r[3]) next.push([r[0], z1, r[2], r[3]]);      // south strip
      if (r[0] < x0) next.push([r[0], z0, x0, z1]);          // west strip
      if (x1 < r[2]) next.push([x1, z0, r[2], z1]);          // east strip
    }
    parts = next;
  }
  return parts;
}
