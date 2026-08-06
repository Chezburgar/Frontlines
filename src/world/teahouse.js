/**
 * TEAHOUSE — a walled Japanese estate built around an open karesansui courtyard.
 *
 * Layout rationale (this is a competitive map first and a building second):
 *
 *   - The courtyard is the map's heart: open to sky, overlooked from the first-floor
 *     gallery on all four sides. It gives attackers a vertical option and defenders a
 *     crossfire, and it splits the ground floor into a ring so no single angle holds
 *     everything.
 *   - Rooms sit in four bands around that ring, so every room has two ways in — one from
 *     the ring, one from its neighbour. No dead ends, no single-entry anchor rooms.
 *   - Shoji screens are the map's signature: they block sight but not bullets, so a
 *     silhouette behind one is a real read and a real risk for both players.
 *   - Interior partitions are soft (plaster or paper). Exterior walls, the four corner
 *     posts and the stair cores are hard, so the building never collapses into one room.
 *   - Windows sit at 0.95 m so a standing player is exposed and a crouched one is not.
 *     Murder holes at 0.28 m give prone-height angles into the courtyard.
 *
 * Coordinates: X east, Z south, Y up. Origin is the centre of the courtyard.
 */
import * as THREE from 'three';
import { MapBuilder, DIM, subtractRects } from './builder.js';
import { BREAK } from './materials.js';

/* ------------------------------------------------------------- dimensions */

const B = {                    // building envelope
  x0: -18, x1: 18, z0: -15, z1: 15,
};
const YARD = { x0: -7, x1: 7, z0: -5, z1: 5 };          // courtyard void
const RING = { x0: -9.5, x1: 9.5, z0: -7.5, z1: 7.5 };  // engawa walkway outer edge
const F0 = 0, F1 = 3.5, ROOF = 7.0;
const H = DIM.storeyH;

/** Room table — drives spawns, objective placement, lighting and the minimap. */
const ROOMS = [
  // ground floor
  { id: 'kura', name: 'Storeroom', floor: 0, rect: [B.x0, B.z0, -9, RING.z0], mat: 'woodFloor' },
  { id: 'shrine', name: 'Shrine', floor: 0, rect: [-9, B.z0, 3, RING.z0], mat: 'woodFloor' },
  { id: 'onsen', name: 'Bath House', floor: 0, rect: [3, B.z0, B.x1, RING.z0], mat: 'stone' },
  { id: 'westhall', name: 'West Hall', floor: 0, rect: [B.x0, RING.z0, RING.x0, RING.z1], mat: 'woodFloor' },
  { id: 'easthall', name: 'East Hall', floor: 0, rect: [RING.x1, RING.z0, B.x1, RING.z1], mat: 'woodFloor' },
  { id: 'tearoom', name: 'Tea Room', floor: 0, rect: [B.x0, RING.z1, -7, B.z1], mat: 'tatami' },
  { id: 'genkan', name: 'Great Hall', floor: 0, rect: [-7, RING.z1, 5, B.z1], mat: 'woodFloor' },
  { id: 'kitchen', name: 'Kitchen', floor: 0, rect: [5, RING.z1, B.x1, B.z1], mat: 'stone' },
  // first floor
  { id: 'tatamiA', name: 'Tatami West', floor: 1, rect: [B.x0, B.z0, -9, RING.z0], mat: 'tatami' },
  { id: 'tatamiB', name: 'Tatami East', floor: 1, rect: [-9, B.z0, 3, RING.z0], mat: 'tatami' },
  { id: 'master', name: 'Master Suite', floor: 1, rect: [3, B.z0, B.x1, RING.z0], mat: 'tatami' },
  { id: 'wgallery', name: 'West Gallery', floor: 1, rect: [B.x0, RING.z0, RING.x0, RING.z1], mat: 'woodFloor' },
  { id: 'egallery', name: 'East Gallery', floor: 1, rect: [RING.x1, RING.z0, B.x1, RING.z1], mat: 'woodFloor' },
  { id: 'study', name: 'Study', floor: 1, rect: [B.x0, RING.z1, -7, B.z1], mat: 'tatami' },
  { id: 'landing', name: 'Landing', floor: 1, rect: [-7, RING.z1, 5, B.z1], mat: 'woodFloor' },
  { id: 'guest', name: 'Guest Room', floor: 1, rect: [5, RING.z1, B.x1, B.z1], mat: 'tatami' },
];

/** Bomb sites: two adjacent rooms each, one pair per floor. */
const OBJECTIVES = [
  { id: 'siteA', name: 'Tea Room / Great Hall', floor: 0, rooms: ['tearoom', 'genkan'], plant: [{ x: -12, y: F0, z: 11.5 }, { x: -1, y: F0, z: 11.5 }] },
  { id: 'siteB', name: 'Tatami / Master', floor: 1, rooms: ['tatamiB', 'master'], plant: [{ x: -3, y: F1, z: -11 }, { x: 10, y: F1, z: -11 }] },
];

/* ================================================================== build */

/** Returns the populated MapBuilder — callers read `.root` plus the room/spawn tables. */
export function buildTeahouse(lib) {
  MapBuilder.issues = [];
  const b = new MapBuilder(lib);
  b.rooms = ROOMS.map((r) => ({ ...r, y: r.floor === 0 ? F0 : F1 }));
  b.objectives = OBJECTIVES;

  grounds(b);
  groundFloor(b);
  firstFloor(b);
  roof(b);
  courtyard(b);
  props(b);
  spawns(b);

  b.finalise();
  if (MapBuilder.issues.length) {
    console.warn(`[teahouse] ${MapBuilder.issues.length} geometry issue(s):`);
    for (const m of MapBuilder.issues) console.warn('  ' + m);
  }
  b.issues = MapBuilder.issues.slice();
  return b;
}

/* ------------------------------------------------------------- exterior */

function grounds(b) {
  // Estate grounds and the perimeter wall that defines the attackers' approach.
  b.box(0, -0.15, 0, 88, 0.3, 80, 'gravel', { texelScale: 0.25 });

  const W = { x0: -30, x1: 30, z0: -26, z1: 26 };
  const wallOpts = { mat: 'plaster', thick: 0.35, height: 2.6, base: 0 };
  // Four runs with gates on the south and north — attackers spawn beyond these.
  b.wall(W.x0, W.z1, W.x1, W.z1, { ...wallOpts, openings: [{ at: 24, w: 3.2, kind: 'arch', head: 2.4 }] });
  b.wall(W.x0, W.z0, W.x1, W.z0, { ...wallOpts, openings: [{ at: 36, w: 3.2, kind: 'arch', head: 2.4 }] });
  b.wall(W.x0, W.z0, W.x0, W.z1, { ...wallOpts, openings: [{ at: 26, w: 2.6, kind: 'arch', head: 2.4 }] });
  b.wall(W.x1, W.z0, W.x1, W.z1, { ...wallOpts, openings: [{ at: 26, w: 2.6, kind: 'arch', head: 2.4 }] });
  // Tiled capping along the top of the perimeter wall.
  for (const [x1, z1, x2, z2] of [[W.x0, W.z0, W.x1, W.z0], [W.x0, W.z1, W.x1, W.z1]]) {
    b.box((x1 + x2) / 2, 2.72, z1, Math.abs(x2 - x1), 0.24, 0.62, 'roofTile', { texelScale: 0.9 });
  }
  for (const x of [W.x0, W.x1]) {
    b.box(x, 2.72, 0, 0.62, 0.24, W.z1 - W.z0, 'roofTile', { texelScale: 0.9 });
  }

  // Stone approach path from the south gate to the genkan.
  b.box(-1, 0.02, 20, 4.5, 0.08, 12, 'stone', { texelScale: 0.5 });

  // Torii gate on the south approach — a landmark for callouts, and hard cover.
  torii(b, -1, 22, 2.0);
}

function torii(b, x, z, scale) {
  const h = 3.4 * scale, w = 3.0 * scale;
  for (const s of [-1, 1]) {
    b.box(x + s * w / 2, h / 2, z, 0.30 * scale, h, 0.30 * scale, 'lacquerRed', { texelScale: 1 });
  }
  b.box(x, h + 0.16 * scale, z, w + 1.5 * scale, 0.32 * scale, 0.5 * scale, 'lacquerRed');
  b.box(x, h - 0.55 * scale, z, w + 0.4 * scale, 0.22 * scale, 0.34 * scale, 'lacquerRed');
}

/* --------------------------------------------------------- ground floor */

function groundFloor(b) {
  const yardHole = [YARD.x0, YARD.z0, YARD.x1, YARD.z1];

  // Slab across the whole footprint except the courtyard.
  for (const r of ROOMS.filter((r) => r.floor === 0)) {
    b.slab(r.rect[0], r.rect[1], r.rect[2], r.rect[3], F0 + 0.02, { mat: r.mat, thick: 0.3 });
  }
  // Engawa ring floor (raised timber veranda around the courtyard).
  for (const rect of subtractRects([RING.x0, RING.z0, RING.x1, RING.z1], [yardHole])) {
    b.slab(rect[0], rect[1], rect[2], rect[3], F0 + 0.02, { mat: 'woodFloor', thick: 0.3 });
  }

  // ---- exterior envelope --------------------------------------------------
  // Plenty of windows: every one is a rappel entry, a peek and a line into a room.
  b.wall(B.x0, B.z0, B.x1, B.z0, {
    mat: 'plaster', height: H, openings: [
      { at: 4, w: 1.4, kind: 'window', barricadeable: true },
      { at: 11, w: 1.4, kind: 'window', barricadeable: true },
      { at: 18, w: 1.6, kind: 'door', barricadeable: true },
      { at: 25, w: 1.4, kind: 'window', barricadeable: true },
      { at: 32, w: 1.4, kind: 'window', barricadeable: true },
    ],
  });
  b.wall(B.x0, B.z1, B.x1, B.z1, {
    mat: 'plaster', height: H, openings: [
      { at: 5, w: 1.4, kind: 'window', barricadeable: true },
      { at: 12, w: 1.4, kind: 'window', barricadeable: true },
      { at: 18, w: 2.4, kind: 'door', head: 2.3, barricadeable: true },   // genkan main entry
      { at: 25, w: 1.4, kind: 'window', barricadeable: true },
      { at: 31, w: 1.4, kind: 'window', barricadeable: true },
    ],
  });
  b.wall(B.x0, B.z0, B.x0, B.z1, {
    mat: 'plaster', height: H, openings: [
      { at: 5, w: 1.4, kind: 'window', barricadeable: true },
      { at: 13, w: 1.6, kind: 'door', barricadeable: true },
      { at: 21, w: 1.4, kind: 'window', barricadeable: true },
      { at: 26, w: 1.4, kind: 'window', barricadeable: true },
    ],
  });
  b.wall(B.x1, B.z0, B.x1, B.z1, {
    mat: 'plaster', height: H, openings: [
      { at: 5, w: 1.4, kind: 'window', barricadeable: true },
      { at: 13, w: 1.6, kind: 'door', barricadeable: true },
      { at: 21, w: 1.4, kind: 'window', barricadeable: true },
      { at: 26, w: 1.4, kind: 'window', barricadeable: true },
    ],
  });

  // ---- interior partitions (destructible) ---------------------------------
  const soft = { mat: 'plaster', thick: DIM.partitionThick, height: H, breakClass: BREAK.PLASTER, reinforceable: true };

  // North band dividers
  b.wall(-9, B.z0, -9, RING.z0, { ...soft, openings: [{ at: 3.5, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  b.wall(3, B.z0, 3, RING.z0, { ...soft, openings: [{ at: 4.5, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  // South band dividers
  b.wall(-7, RING.z1, -7, B.z1, { ...soft, openings: [{ at: 4.0, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  b.wall(5, RING.z1, 5, B.z1, { ...soft, openings: [{ at: 3.0, w: 1.1, kind: 'door', screen: 'fusuma' }] });

  // Band-to-ring walls: mostly shoji, which is what makes the ring so dangerous to walk.
  const shojiRun = (x1, z1, x2, z2, count) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const openings = [];
    const step = len / count;
    for (let i = 0; i < count; i++) {
      openings.push({ at: step * (i + 0.5), w: step * 0.82, kind: 'arch', head: DIM.shojiH, screen: 'shoji' });
    }
    b.wall(x1, z1, x2, z2, { mat: 'woodBeam', thick: 0.09, height: H, openings });
  };
  shojiRun(B.x0, RING.z0, RING.x0, RING.z0, 3);   // west hall / north band
  shojiRun(RING.x1, RING.z0, B.x1, RING.z0, 3);
  shojiRun(B.x0, RING.z1, RING.x0, RING.z1, 3);
  shojiRun(RING.x1, RING.z1, B.x1, RING.z1, 3);
  // The ring's west and east faces. These only exist alongside the ring itself
  // (z = RING.z0..RING.z1) — previously they were run from the building edge to the ring,
  // which put a spurious wall at x = +-9.5 straight through the north and south bands,
  // half a metre from the real partitions and interpenetrating their door frames.
  shojiRun(RING.x0, RING.z0, RING.x0, RING.z1, 4);
  shojiRun(RING.x1, RING.z0, RING.x1, RING.z1, 4);

  // Ring inner face onto the courtyard: open bays between posts, with murder holes in the
  // low spandrels so defenders can hold the yard from cover.
  courtyardColonnade(b, F0);

  // ---- vertical connections ----------------------------------------------
  // Two stair cores on opposite sides so neither team owns both rotations.
  b.stairs(-16.5, 5.5, -16.5, -1.5, F0, F1, 1.6);
  b.stairs(16.5, -5.5, 16.5, 1.5, F0, F1, 1.6);

  // Hatches: one per band, deliberately not adjacent to the stairs.
  b.hatch(-13, -11, F1);
  b.hatch(0, -11, F1);
  b.hatch(11, 11, F1);
  b.hatch(-12, 11, F1);
}

/**
 * The engawa colonnade: posts every 3.5 m with a low spandrel between them. Open above
 * waist height so the courtyard is visible from the ring, which is the whole point.
 */
function courtyardColonnade(b, y) {
  const step = 3.5;
  const rails = [
    [YARD.x0, YARD.z0, YARD.x1, YARD.z0],
    [YARD.x0, YARD.z1, YARD.x1, YARD.z1],
    [YARD.x0, YARD.z0, YARD.x0, YARD.z1],
    [YARD.x1, YARD.z0, YARD.x1, YARD.z1],
  ];
  for (const [x1, z1, x2, z2] of rails) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const n = Math.max(2, Math.round(len / step));
    const ux = (x2 - x1) / len, uz = (z2 - z1) / len;
    for (let i = 0; i <= n; i++) {
      b.post(x1 + ux * (len * i / n), z1 + uz * (len * i / n), y, DIM.storeyH);
    }
    // Waist-height balustrade with gaps at the four cardinal entries to the yard.
    b.wall(x1, z1, x2, z2, {
      mat: 'woodBeam', thick: 0.12, height: 0.62, base: y + 0.02,
      openings: [{ at: len / 2, w: 2.0, kind: 'open', head: 0.62 }],
      trim: false,
    });
  }
}

/* ---------------------------------------------------------- first floor */

function firstFloor(b) {
  const yardHole = [YARD.x0, YARD.z0, YARD.x1, YARD.z1];
  const stairHoleW = [-17.4, -2.2, -15.6, 6.2];
  const stairHoleE = [15.6, -6.2, 17.4, 2.2];
  const hatchHoles = [
    [-13.6, -11.6, -12.4, -10.4], [-0.6, -11.6, 0.6, -10.4],
    [10.4, 10.4, 11.6, 11.6], [-12.6, 10.4, -11.4, 11.6],
  ];
  const holes = [yardHole, stairHoleW, stairHoleE, ...hatchHoles];

  for (const r of ROOMS.filter((r) => r.floor === 1)) {
    b.slab(r.rect[0], r.rect[1], r.rect[2], r.rect[3], F1, {
      mat: r.mat, thick: 0.26, holes, ceiling: 'woodLight',
    });
  }
  for (const rect of subtractRects([RING.x0, RING.z0, RING.x1, RING.z1], holes)) {
    b.slab(rect[0], rect[1], rect[2], rect[3], F1, { mat: 'woodFloor', thick: 0.26, ceiling: 'woodLight' });
  }

  // Exterior envelope, upper storey. More glazing than below — this is the rappel floor.
  const win = (at) => ({ at, w: 1.5, kind: 'window', barricadeable: true });
  b.wall(B.x0, B.z0, B.x1, B.z0, { mat: 'plaster', height: H, base: F1, openings: [win(5), win(12), win(19), win(26), win(32)] });
  b.wall(B.x0, B.z1, B.x1, B.z1, { mat: 'plaster', height: H, base: F1, openings: [win(5), win(12), win(19), win(26), win(32)] });
  b.wall(B.x0, B.z0, B.x0, B.z1, { mat: 'plaster', height: H, base: F1, openings: [win(6), win(14), win(22), win(27)] });
  b.wall(B.x1, B.z0, B.x1, B.z1, { mat: 'plaster', height: H, base: F1, openings: [win(6), win(14), win(22), win(27)] });

  const soft = { mat: 'plaster', thick: DIM.partitionThick, height: H, base: F1, breakClass: BREAK.PLASTER, reinforceable: true };
  b.wall(-9, B.z0, -9, RING.z0, { ...soft, openings: [{ at: 3.5, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  b.wall(3, B.z0, 3, RING.z0, { ...soft, openings: [{ at: 4.5, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  b.wall(-7, RING.z1, -7, B.z1, { ...soft, openings: [{ at: 4.0, w: 1.1, kind: 'door', screen: 'fusuma' }] });
  b.wall(5, RING.z1, 5, B.z1, { ...soft, openings: [{ at: 3.0, w: 1.1, kind: 'door', screen: 'fusuma' }] });

  const shojiRun = (x1, z1, x2, z2, count) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const openings = [];
    for (let i = 0; i < count; i++) {
      openings.push({ at: (len / count) * (i + 0.5), w: (len / count) * 0.82, kind: 'arch', head: DIM.shojiH, screen: 'shoji' });
    }
    b.wall(x1, z1, x2, z2, { mat: 'woodBeam', thick: 0.09, height: H, base: F1, openings });
  };
  shojiRun(B.x0, RING.z0, RING.x0, RING.z0, 3);
  shojiRun(RING.x1, RING.z0, B.x1, RING.z0, 3);
  shojiRun(B.x0, RING.z1, RING.x0, RING.z1, 3);
  shojiRun(RING.x1, RING.z1, B.x1, RING.z1, 3);
  // The ring's west and east faces. These only exist alongside the ring itself
  // (z = RING.z0..RING.z1) — previously they were run from the building edge to the ring,
  // which put a spurious wall at x = +-9.5 straight through the north and south bands,
  // half a metre from the real partitions and interpenetrating their door frames.
  shojiRun(RING.x0, RING.z0, RING.x0, RING.z1, 4);
  shojiRun(RING.x1, RING.z0, RING.x1, RING.z1, 4);

  // Gallery balustrade overlooking the courtyard, with murder holes for prone angles.
  const rails = [
    [YARD.x0, YARD.z0, YARD.x1, YARD.z0], [YARD.x0, YARD.z1, YARD.x1, YARD.z1],
    [YARD.x0, YARD.z0, YARD.x0, YARD.z1], [YARD.x1, YARD.z0, YARD.x1, YARD.z1],
  ];
  for (const [x1, z1, x2, z2] of rails) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    b.wall(x1, z1, x2, z2, {
      mat: 'woodBeam', thick: 0.12, height: 1.0, base: F1,
      openings: [
        { at: len * 0.28, w: 0.34, kind: 'murderhole', sill: 0.30, head: 0.64 },
        { at: len * 0.72, w: 0.34, kind: 'murderhole', sill: 0.30, head: 0.64 },
      ],
      trim: false,
    });
    const n = Math.max(2, Math.round(len / 3.5));
    const ux = (x2 - x1) / len, uz = (z2 - z1) / len;
    for (let i = 0; i <= n; i++) b.post(x1 + ux * (len * i / n), z1 + uz * (len * i / n), F1, DIM.storeyH);
  }
}

/* ---------------------------------------------------------------- roof */

function roof(b) {
  // Hipped tile roof over the two bands, leaving the courtyard open.
  const eave = 0.9;
  const bands = [
    [B.x0 - eave, B.z0 - eave, B.x1 + eave, RING.z0],
    [B.x0 - eave, RING.z1, B.x1 + eave, B.z1 + eave],
    [B.x0 - eave, RING.z0, RING.x0, RING.z1],
    [RING.x1, RING.z0, B.x1 + eave, RING.z1],
  ];
  for (const [x0, z0, x1, z1] of bands) {
    const w = x1 - x0, d = z1 - z0;
    // Two shallow pitches meeting at a ridge, approximated with rotated slabs.
    const short = Math.min(w, d);
    const pitch = 0.34;
    const rise = (short / 2) * pitch;
    const along = w > d;
    for (const s of [-1, 1]) {
      const geo = new THREE.BoxGeometry(along ? w : short / 2 / Math.cos(Math.atan(pitch)), 0.16,
                                        along ? short / 2 / Math.cos(Math.atan(pitch)) : d);
      b._scaleBoxUVs(geo, along ? w : short / 2, 0.16, along ? short / 2 : d, 0.7);
      if (along) geo.rotateX(s * Math.atan(pitch));
      else geo.rotateZ(-s * Math.atan(pitch));
      geo.translate(
        (x0 + x1) / 2 + (along ? 0 : s * short / 4),
        ROOF + rise / 2,
        (z0 + z1) / 2 + (along ? s * short / 4 : 0),
      );
      b._push('roofTile', geo);
    }
    // Ridge beam
    b.box((x0 + x1) / 2, ROOF + rise + 0.1, (z0 + z1) / 2,
      along ? w : 0.4, 0.2, along ? 0.4 : d, 'woodBeam', { texelScale: 1.0 });
  }
}

/* ----------------------------------------------------------- courtyard */

function courtyard(b) {
  // Raked gravel bed.
  b.box(0, F0 - 0.08, 0, YARD.x1 - YARD.x0, 0.2, YARD.z1 - YARD.z0, 'gravel', { texelScale: 0.45 });

  // Koi pond — shallow, walkable around, and a reflective surface under the sky opening.
  const pond = b.box(-2.4, F0 - 0.02, 1.0, 5.0, 0.06, 3.2, 'water', { standalone: true, castShadow: false });
  b.propGroup.add(pond);
  b.box(-2.4, F0 - 0.14, 1.0, 5.6, 0.2, 3.8, 'stone', { texelScale: 0.8 });

  // Set stones — the karesansui composition, and genuinely useful low cover.
  const stones = [[3.2, -2.6, 1.1, 0.8], [4.6, 0.4, 0.7, 0.55], [1.4, 2.8, 0.9, 0.65], [-5.2, -2.2, 0.8, 0.6]];
  for (const [x, z, r, h] of stones) {
    const geo = new THREE.IcosahedronGeometry(r, 1);
    geo.scale(1, h / r, 0.85);
    geo.translate(x, F0 + h * 0.4, z);
    b._push('stone', geo);
  }

  // Stone lanterns flanking the yard entries.
  for (const [x, z] of [[-6.2, -4.2], [6.2, -4.2], [-6.2, 4.2], [6.2, 4.2]]) lantern(b, x, z, F0);

  // Bamboo clusters in two corners — sight blockers that still let sound through.
  for (const [cx, cz] of [[5.6, 3.4], [-5.6, -3.4]]) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + cx;
      const r = 0.35 + (i % 3) * 0.28;
      const h = 3.6 + (i % 4) * 0.7;
      const geo = new THREE.CylinderGeometry(0.045, 0.055, h, 6);
      geo.translate(cx + Math.cos(a) * r, F0 + h / 2, cz + Math.sin(a) * r);
      b._push('bamboo', geo);
    }
  }

  // A maple over the pond, for silhouette and shadow play through the courtyard opening.
  maple(b, 3.0, F0, -0.6);
}

function lantern(b, x, z, y) {
  b.box(x, y + 0.18, z, 0.62, 0.36, 0.62, 'stone', { texelScale: 1.4 });
  b.box(x, y + 0.62, z, 0.24, 0.55, 0.24, 'stone', { texelScale: 1.4 });
  b.box(x, y + 1.02, z, 0.5, 0.34, 0.5, 'paperLamp', { texelScale: 1.4 });
  b.box(x, y + 1.28, z, 0.72, 0.14, 0.72, 'stone', { texelScale: 1.4 });
  b.lights.push({ x, y: y + 1.05, z, color: 0xffb877, intensity: 5.5, distance: 9 });
}

function maple(b, x, y, z) {
  const h = 4.4;
  const trunk = new THREE.CylinderGeometry(0.10, 0.20, h, 7);
  trunk.translate(x, y + h / 2, z);
  b._push('woodBeam', trunk);
  const rnd = (n) => Math.sin(n * 12.9898) * 43758.5453 % 1;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const r = 0.9 + Math.abs(rnd(i)) * 0.7;
    const cy = y + h * (0.62 + (i % 3) * 0.12);
    const blob = new THREE.IcosahedronGeometry(1.05 + Math.abs(rnd(i + 9)) * 0.5, 1);
    blob.scale(1.2, 0.62, 1.2);
    blob.translate(x + Math.cos(a) * r, cy, z + Math.sin(a) * r);
    b._push('foliage', blob);
  }
}

/* --------------------------------------------------------------- props */

function props(b) {
  // Ceiling paper lanterns light the interior bands and give the lighting rig anchors.
  const lampSpots = [
    [-13, -11], [-3, -11], [10, -11],
    [-13, 0], [13, 0],
    [-12, 11], [-1, 11], [11, 11],
  ];
  for (const [x, z] of lampSpots) {
    for (const y of [F0, F1]) {
      const geo = new THREE.SphereGeometry(0.28, 12, 10);
      geo.scale(1, 0.8, 1);
      geo.translate(x, y + 2.55, z);
      b._push('paperLamp', geo);
      b.lights.push({ x, y: y + 2.5, z, color: 0xffc48a, intensity: 7.5, distance: 11 });
    }
  }

  // Low furniture: tea tables, chests and screens. All shootable, all useful as cover.
  const tables = [[-13, 11.5], [-11, 9], [1, 11], [12, -11.5], [-4, -11]];
  for (const [x, z] of tables) {
    b.box(x, F0 + 0.16, z, 1.5, 0.09, 0.9, 'woodBeam', { texelScale: 1.2 });
    for (const [dx, dz] of [[-0.62, -0.34], [0.62, -0.34], [-0.62, 0.34], [0.62, 0.34]]) {
      b.box(x + dx, F0 + 0.07, z + dz, 0.09, 0.14, 0.09, 'woodBeam', { texelScale: 2 });
    }
  }
  // Storeroom crates — the one room with genuine chest-high cover.
  const crates = [[-15.5, -13], [-14, -12.4], [-15.8, -10.6], [-12.5, -13.4], [-13.2, -9.4]];
  for (const [x, z] of crates) {
    const s = 0.8 + ((x * 7 + z * 13) % 5) * 0.08;
    b.box(x, F0 + s / 2, z, s, s, s * 0.9, 'woodLight', { texelScale: 1.1 });
  }
}

/* -------------------------------------------------------------- spawns */

function spawns(b) {
  // Attackers spawn outside the perimeter on all four approaches; defenders inside.
  b.spawns.attack = [
    { name: 'South Gate', points: ring(-1, 24.5, 4) },
    { name: 'North Grove', points: ring(6, -23.5, 4) },
    { name: 'East Lane', points: ring(25.5, 2, 4) },
    { name: 'West Garden', points: ring(-25.5, -2, 4) },
  ];
  b.spawns.defend = [
    { name: 'Great Hall', points: ring(-1, 11.5, 3, 2.4) },
    { name: 'Tatami', points: ring(-3, -11, 3, 2.4) },
    { name: 'Bath House', points: ring(10.5, -11, 2, 2.4) },
    { name: 'West Hall', points: ring(-13.5, 0, 2, 2.4) },
  ];
}

function ring(cx, cz, n, r = 2.0) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: 0, z: cz + Math.sin(a) * r };
  });
}

export { ROOMS, OBJECTIVES, B as ENVELOPE, YARD, RING, F0, F1, ROOF };
