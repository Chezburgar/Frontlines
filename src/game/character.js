/**
 * Operator model.
 *
 * Built and rigged in code because the supplied reference mesh had no skeleton. Rather
 * than fake it with parented rigid parts (which visibly break at the shoulders and hips),
 * this generates a real SkinnedMesh: a 22-bone humanoid skeleton, limb geometry lathed
 * around each bone chain, and skin weights solved per vertex from distance to the bone
 * segments so elbows, knees and the waist deform smoothly.
 *
 * Everything is one merged geometry with a small palette of materials, so a full 10-player
 * lobby costs 10 skinned draw calls rather than a few hundred.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------- proportions */

/**
 * Bone rest positions, in metres, for a 1.80 m operator. Y is up, +Z forward.
 * Positions are given in world space and converted to parent-local on assembly, which is
 * far easier to author and reason about than nested offsets.
 */
const SKELETON = {
  hips: { pos: [0, 0.98, 0], parent: null },
  spine: { pos: [0, 1.12, 0], parent: 'hips' },
  chest: { pos: [0, 1.32, 0], parent: 'spine' },
  neck: { pos: [0, 1.52, 0], parent: 'chest' },
  head: { pos: [0, 1.62, 0], parent: 'neck' },

  shoulderL: { pos: [0.19, 1.46, 0], parent: 'chest' },
  upperArmL: { pos: [0.30, 1.44, 0], parent: 'shoulderL' },
  forearmL: { pos: [0.30, 1.17, 0.02], parent: 'upperArmL' },
  handL: { pos: [0.30, 0.92, 0.04], parent: 'forearmL' },

  shoulderR: { pos: [-0.19, 1.46, 0], parent: 'chest' },
  upperArmR: { pos: [-0.30, 1.44, 0], parent: 'shoulderR' },
  forearmR: { pos: [-0.30, 1.17, 0.02], parent: 'upperArmR' },
  handR: { pos: [-0.30, 0.92, 0.04], parent: 'forearmR' },

  thighL: { pos: [0.11, 0.94, 0], parent: 'hips' },
  shinL: { pos: [0.115, 0.52, 0.01], parent: 'thighL' },
  footL: { pos: [0.115, 0.09, 0.0], parent: 'shinL' },
  toeL: { pos: [0.115, 0.04, 0.14], parent: 'footL' },

  thighR: { pos: [-0.11, 0.94, 0], parent: 'hips' },
  shinR: { pos: [-0.115, 0.52, 0.01], parent: 'thighR' },
  footR: { pos: [-0.115, 0.09, 0.0], parent: 'shinR' },
  toeR: { pos: [-0.115, 0.04, 0.14], parent: 'footR' },
};

/**
 * Limb definitions: a chain of rings swept between two bones, each ring given a radius
 * profile. This is what gives the body its silhouette — tapered forearms, a bulked torso
 * from the plate carrier, boot flare at the ankle.
 *
 * `sections` are [t, radiusX, radiusZ] along the bone segment, t from 0 (start) to 1.
 */
const LIMBS = [
  // torso: hips -> chest, bulked by the plate carrier
  { from: 'hips', to: 'spine', mat: 'gear', sections: [[0, 0.155, 0.115], [1, 0.165, 0.125]], sides: 12 },
  { from: 'spine', to: 'chest', mat: 'gear', sections: [[0, 0.175, 0.135], [0.55, 0.195, 0.150], [1, 0.185, 0.140]], sides: 12 },
  { from: 'chest', to: 'neck', mat: 'cloth', sections: [[0, 0.150, 0.125], [1, 0.075, 0.075]], sides: 10 },
  { from: 'neck', to: 'head', mat: 'skin', sections: [[0, 0.062, 0.062], [1, 0.078, 0.080]], sides: 10 },

  // Arms sweep as one piece from the shoulder to the wrist. Modelling the deltoid as its
  // own short stub between shoulderL and upperArmL put a fat 8-sided cylinder pointing
  // straight out of the torso, which reads end-on as an angular shard no matter how it is
  // weighted — the continuous sweep gives a shoulder that actually merges into the chest.
  { from: 'shoulderL', to: 'forearmL', mat: 'cloth', sides: 10,
    sections: [[0, 0.088, 0.088], [0.18, 0.072, 0.072], [1, 0.047, 0.047]] },
  { from: 'forearmL', to: 'handL', mat: 'cloth', sides: 8,
    sections: [[0, 0.048, 0.048], [0.8, 0.038, 0.038], [1, 0.034, 0.034]] },
  { from: 'shoulderR', to: 'forearmR', mat: 'cloth', sides: 10,
    sections: [[0, 0.088, 0.088], [0.18, 0.072, 0.072], [1, 0.047, 0.047]] },
  { from: 'forearmR', to: 'handR', mat: 'cloth', sides: 8,
    sections: [[0, 0.048, 0.048], [0.8, 0.038, 0.038], [1, 0.034, 0.034]] },

  // Legs. Intermediate rings give the knee geometry to bend through, and the thigh runs
  // past t=1 so it overlaps the shin: two tubes meeting exactly at the joint split open
  // visibly on a deep crouch, because neither has vertices there to deform.
  { from: 'thighL', to: 'shinL', mat: 'cloth', sides: 10,
    sections: [[0, 0.095, 0.100], [0.45, 0.080, 0.084], [0.8, 0.068, 0.072], [1.16, 0.061, 0.065]] },
  { from: 'shinL', to: 'footL', mat: 'cloth', sides: 10,
    sections: [[-0.14, 0.064, 0.068], [0.35, 0.056, 0.060], [0.75, 0.050, 0.054], [1, 0.055, 0.058]] },
  { from: 'thighR', to: 'shinR', mat: 'cloth', sides: 10,
    sections: [[0, 0.095, 0.100], [0.45, 0.080, 0.084], [0.8, 0.068, 0.072], [1.16, 0.061, 0.065]] },
  { from: 'shinR', to: 'footR', mat: 'cloth', sides: 10,
    sections: [[-0.14, 0.064, 0.068], [0.35, 0.056, 0.060], [0.75, 0.050, 0.054], [1, 0.055, 0.058]] },
];

/** Rigid attachments — helmet, boots, pouches. Bound fully to one bone each. */
const ATTACHMENTS = [
  { bone: 'head', mat: 'gear', shape: 'sphere', pos: [0, 0.055, 0.004], scale: [0.098, 0.092, 0.104] },
  { bone: 'head', mat: 'gear', shape: 'box', pos: [0, 0.012, 0.062], scale: [0.13, 0.045, 0.06] },   // NVG mount / brow
  { bone: 'head', mat: 'visor', shape: 'box', pos: [0, -0.012, 0.070], scale: [0.115, 0.05, 0.03] }, // eye protection
  // Plates sit just proud of the torso sweep (radius ~0.15 at the chest) rather than
  // outside it — any bigger and the carrier reads as a sandwich board, not armour.
  { bone: 'chest', mat: 'plate', shape: 'box', pos: [0, -0.03, 0.108], scale: [0.125, 0.150, 0.022] },
  { bone: 'chest', mat: 'plate', shape: 'box', pos: [0, -0.03, -0.108], scale: [0.125, 0.150, 0.022] },
  { bone: 'chest', mat: 'pouch', shape: 'box', pos: [0.085, -0.115, 0.115], scale: [0.045, 0.045, 0.032] },
  { bone: 'chest', mat: 'pouch', shape: 'box', pos: [-0.005, -0.115, 0.118], scale: [0.045, 0.045, 0.032] },
  { bone: 'chest', mat: 'pouch', shape: 'box', pos: [-0.092, -0.115, 0.112], scale: [0.045, 0.045, 0.032] },
  { bone: 'hips', mat: 'pouch', shape: 'box', pos: [0.140, -0.03, 0.015], scale: [0.040, 0.062, 0.042] },
  { bone: 'hips', mat: 'pouch', shape: 'box', pos: [-0.140, -0.03, 0.015], scale: [0.040, 0.062, 0.042] },
  { bone: 'thighL', mat: 'pouch', shape: 'box', pos: [0.052, -0.20, 0.028], scale: [0.040, 0.085, 0.038] },
  { bone: 'footL', mat: 'boot', shape: 'box', pos: [0, -0.035, 0.055], scale: [0.062, 0.038, 0.115] },
  { bone: 'footR', mat: 'boot', shape: 'box', pos: [0, -0.035, 0.055], scale: [0.062, 0.038, 0.115] },
  { bone: 'shinL', mat: 'gear', shape: 'box', pos: [0, -0.11, 0.055], scale: [0.055, 0.06, 0.03] },  // knee pad
  { bone: 'shinR', mat: 'gear', shape: 'box', pos: [0, -0.11, 0.055], scale: [0.055, 0.06, 0.03] },
  // Shoulder armour, rounded and hugging the sweep rather than protruding from it.
  { bone: 'shoulderL', mat: 'gear', shape: 'sphere', pos: [0.035, -0.005, 0], scale: [0.075, 0.070, 0.082] },
  { bone: 'shoulderR', mat: 'gear', shape: 'sphere', pos: [-0.035, -0.005, 0], scale: [0.075, 0.070, 0.082] },
];

/* ------------------------------------------------------------- generation */

/** Builds the bone hierarchy and returns { bones, root, byName, restWorld }. */
function buildSkeleton() {
  const byName = {};
  const bones = [];
  const restWorld = {};

  // Depth-first so a parent always exists before its children.
  const order = [];
  const visit = (name) => {
    if (order.includes(name)) return;
    const def = SKELETON[name];
    if (def.parent) visit(def.parent);
    order.push(name);
  };
  Object.keys(SKELETON).forEach(visit);

  for (const name of order) {
    const def = SKELETON[name];
    const bone = new THREE.Bone();
    bone.name = name;
    const world = new THREE.Vector3(...def.pos);
    restWorld[name] = world.clone();
    if (def.parent) {
      bone.position.copy(world).sub(restWorld[def.parent]);
      byName[def.parent].add(bone);
    } else {
      bone.position.copy(world);
    }
    byName[name] = bone;
    bones.push(bone);
  }
  return { bones, root: byName.hips, byName, restWorld };
}

/**
 * Solves skin weights for a vertex.
 *
 * Distance is measured to each bone's *segment* (the line from the bone to its parent),
 * not its origin — weighting by origin distance makes the shoulders and hips collapse,
 * because a point on the upper arm can sit nearer the chest origin than the arm's.
 */
function solveWeights(p, segments, maxInfluences = 4) {
  const scored = [];
  for (const seg of segments) {
    const d = distanceToSegment(p, seg.a, seg.b);
    // Falloff is a balance: too gentle (d^3) and the chest reaches the upper arm, tearing
    // the shoulder when it swings to aim; too steep (d^6) and a vertex at the knee snaps
    // entirely to thigh or shin, splitting the leg open on a deep crouch. d^4 blends the
    // joint while staying local. The shoulder is solved geometrically instead — the arm
    // sweeps as one piece — so the weighting no longer has to carry that case.
    scored.push({ index: seg.index, w: 1 / (Math.pow(d, 4) + 1e-5) });
  }
  scored.sort((a, b) => b.w - a.w);
  const top = scored.slice(0, maxInfluences);
  const best = top[0]?.w ?? 1;
  const kept = top.filter((t) => t.w > best * 0.03);
  const total = kept.reduce((s, t) => s + t.w, 0) || 1;
  const idx = [0, 0, 0, 0], wt = [0, 0, 0, 0];
  for (let i = 0; i < kept.length; i++) { idx[i] = kept[i].index; wt[i] = kept[i].w / total; }
  return { idx, wt };
}

const _ab = new THREE.Vector3(), _ap = new THREE.Vector3();
function distanceToSegment(p, a, b) {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq();
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, _ap.dot(_ab) / len2));
  return _ap.copy(a).addScaledVector(_ab, t).distanceTo(p);
}

/** Sweeps a tube between two bone positions using the section profile. */
function limbGeometry(a, b, sections, sides) {
  const axis = new THREE.Vector3().subVectors(b, a);
  const len = axis.length();
  const dir = axis.clone().normalize();
  // Stable perpendicular frame.
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const nx = new THREE.Vector3().crossVectors(up, dir).normalize();
  const nz = new THREE.Vector3().crossVectors(dir, nx).normalize();

  const positions = [];
  const indices = [];
  const rings = sections.length;

  for (let s = 0; s < rings; s++) {
    const [t, rx, rz] = sections[s];
    const centre = a.clone().addScaledVector(dir, len * t);
    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2;
      const p = centre.clone()
        .addScaledVector(nx, Math.cos(ang) * rx)
        .addScaledVector(nz, Math.sin(ang) * rz);
      positions.push(p.x, p.y, p.z);
    }
  }
  for (let s = 0; s < rings - 1; s++) {
    for (let i = 0; i < sides; i++) {
      const i0 = s * sides + i;
      const i1 = s * sides + ((i + 1) % sides);
      const i2 = (s + 1) * sides + i;
      const i3 = (s + 1) * sides + ((i + 1) % sides);
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }
  // Cap both ends so limbs are closed solids (matters for silhouette and shadows).
  const capStart = positions.length / 3;
  positions.push(a.x, a.y, a.z);
  for (let i = 0; i < sides; i++) indices.push(capStart, (i + 1) % sides, i);
  const capEnd = positions.length / 3;
  positions.push(b.x, b.y, b.z);
  const base = (rings - 1) * sides;
  for (let i = 0; i < sides; i++) indices.push(capEnd, base + i, base + ((i + 1) % sides));

  return { positions, indices };
}

function boxGeometry(centre, scale) {
  const g = new THREE.BoxGeometry(scale[0] * 2, scale[1] * 2, scale[2] * 2);
  g.translate(centre.x, centre.y, centre.z);
  return { positions: [...g.attributes.position.array], indices: [...g.index.array], geo: g };
}

function sphereGeometry(centre, scale) {
  const g = new THREE.SphereGeometry(1, 12, 10);
  g.scale(scale[0], scale[1], scale[2]);
  g.translate(centre.x, centre.y, centre.z);
  return { positions: [...g.attributes.position.array], indices: [...g.index.array], geo: g };
}

/* ------------------------------------------------------------- materials */

/**
 * Team palettes.
 *
 * Values are deliberately mid-tone rather than the near-black tactical gear reads as in
 * reference photos: under interior lighting a genuinely dark operator becomes an
 * unreadable silhouette, and players need to identify a target and its facing at 30 m.
 * Attackers run warm desert tan, defenders cool slate — separable even in shadow.
 */
const PALETTES = {
  attack: { cloth: 0x7a6a52, gear: 0x544c3e, plate: 0x6b5f49, pouch: 0x665944, boot: 0x3a342c, skin: 0xa9805e, visor: 0x1b2026 },
  defend: { cloth: 0x53616b, gear: 0x3b454e, plate: 0x4a565f, pouch: 0x44505a, boot: 0x2a3036, skin: 0xa9805e, visor: 0x1b2026 },
};

function buildMaterials(team) {
  const p = PALETTES[team] ?? PALETTES.attack;
  const mk = (color, rough, metal = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  return {
    cloth: mk(p.cloth, 0.92),
    gear: mk(p.gear, 0.74, 0.06),
    plate: mk(p.plate, 0.55, 0.12),
    pouch: mk(p.pouch, 0.88),
    boot: mk(p.boot, 0.62, 0.05),
    skin: mk(p.skin, 0.76),
    visor: mk(p.visor, 0.18, 0.65),
  };
}

/* ------------------------------------------------------------------ build */

/**
 * Creates a rigged operator.
 * @returns {{ group: THREE.Group, mesh: THREE.SkinnedMesh, skeleton: THREE.Skeleton,
 *             bones: Object<string,THREE.Bone>, materials: object }}
 */
export function createOperator({ team = 'attack' } = {}) {
  const { bones, root, byName, restWorld } = buildSkeleton();
  const boneIndex = {};
  bones.forEach((b, i) => { boneIndex[b.name] = i; });

  // Weighting segments: each bone paired with its parent forms a capsule to measure against.
  const segments = bones.map((b) => {
    const def = SKELETON[b.name];
    const a = restWorld[b.name];
    const parent = def.parent ? restWorld[def.parent] : a;
    return { index: boneIndex[b.name], a: parent.clone(), b: a.clone() };
  });

  const materials = buildMaterials(team);
  const matOrder = ['cloth', 'gear', 'plate', 'pouch', 'boot', 'skin', 'visor'];

  const positions = [];
  const skinIndices = [];
  const skinWeights = [];
  const groups = [];          // { start, count, materialIndex }
  const indices = [];

  const emit = (parts, matName, forceBone = null) => {
    const vOff = positions.length / 3;
    const iStart = indices.length;
    for (let i = 0; i < parts.positions.length; i += 3) {
      const p = new THREE.Vector3(parts.positions[i], parts.positions[i + 1], parts.positions[i + 2]);
      positions.push(p.x, p.y, p.z);
      if (forceBone !== null) {
        skinIndices.push(forceBone, 0, 0, 0);
        skinWeights.push(1, 0, 0, 0);
      } else {
        const { idx, wt } = solveWeights(p, segments);
        skinIndices.push(...idx);
        skinWeights.push(...wt);
      }
    }
    for (const i of parts.indices) indices.push(i + vOff);
    groups.push({ start: iStart, count: indices.length - iStart, materialIndex: matOrder.indexOf(matName) });
  };

  for (const limb of LIMBS) {
    const a = restWorld[limb.from], b = restWorld[limb.to];
    emit(limbGeometry(a, b, limb.sections, limb.sides), limb.mat,
      limb.rigid ? boneIndex[limb.rigid] : null);
  }

  for (const att of ATTACHMENTS) {
    const origin = restWorld[att.bone];
    const centre = new THREE.Vector3(...att.pos).add(origin);
    const parts = att.shape === 'sphere'
      ? sphereGeometry(centre, att.scale)
      : boxGeometry(centre, att.scale);
    parts.geo?.dispose();
    // Rigid gear rides one bone exactly — a helmet must not stretch with the neck.
    emit(parts, att.mat, boneIndex[att.bone]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  // Merge groups that share a material so the draw call count stays at one per material.
  const merged = new Map();
  for (const g of groups) {
    if (!merged.has(g.materialIndex)) merged.set(g.materialIndex, []);
    merged.get(g.materialIndex).push(g);
  }
  // Re-order the index buffer so each material's triangles are contiguous.
  const newIndex = [];
  for (const mi of [...merged.keys()].sort((a, b) => a - b)) {
    const start = newIndex.length;
    for (const g of merged.get(mi)) {
      for (let i = g.start; i < g.start + g.count; i++) newIndex.push(indices[i]);
    }
    geo.addGroup(start, newIndex.length - start, mi);
  }
  geo.setIndex(newIndex);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new THREE.SkinnedMesh(geo, matOrder.map((m) => materials[m]));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.add(root);
  group.add(mesh);

  // Order matters: THREE.Skeleton computes each bone's inverse bind matrix from its
  // *current* world matrix at construction. Built before the hierarchy is attached and
  // updated, those inverses capture identity matrices and the mesh explodes on the first
  // pose. Flush world matrices first, then bind.
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, mesh.matrixWorld);

  return { group, mesh, skeleton, bones: byName, materials, restWorld, boneIndex };
}

/* ------------------------------------------------------------- animation */

/**
 * Procedural animation rig.
 *
 * Keyframed clips would need an authoring tool, so poses are driven analytically from the
 * character's state: a gait cycle for the legs, an aim chain for the upper body, and
 * additive lean/crouch offsets. That also means the pose responds continuously to speed
 * and aim rather than blending between fixed clips.
 */
export class OperatorAnimator {
  constructor(rig) {
    this.rig = rig;
    this.b = rig.bones;
    this.phase = 0;
    this.tmpQ = new THREE.Quaternion();
    this.tmpE = new THREE.Euler();
    // Cache rest rotations so every pose is applied as a delta from the bind pose.
    this.rest = {};
    for (const [name, bone] of Object.entries(this.b)) this.rest[name] = bone.quaternion.clone();
  }

  /**
   * @param {number} dt
   * @param {object} s state: { speed, grounded, crouch (0..1), lean (-1..1), pitch, aim (0..1) }
   */
  update(dt, s) {
    const speed = s.speed ?? 0;
    const stride = THREE.MathUtils.clamp(speed / 3.4, 0, 1.4);
    this.phase += dt * (4.2 + stride * 3.4) * (speed > 0.15 ? 1 : 0);

    const set = (name, x, y, z) => {
      const bone = this.b[name];
      if (!bone) return;
      this.tmpE.set(x, y, z, 'XYZ');
      this.tmpQ.setFromEuler(this.tmpE);
      bone.quaternion.copy(this.rest[name]).multiply(this.tmpQ);
    };

    const sw = Math.sin(this.phase) * stride;
    const swAlt = Math.sin(this.phase + Math.PI) * stride;
    const bob = Math.abs(Math.cos(this.phase)) * stride;

    const crouch = s.crouch ?? 0;
    const lean = s.lean ?? 0;
    const pitch = THREE.MathUtils.clamp(s.pitch ?? 0, -1.2, 1.2);
    const aim = s.aim ?? 0;

    // Legs: swing plus a crouch-driven bend. Angles stay moderate — a full squat looks
    // right on a still frame but the skinned knee cannot carry that much rotation.
    set('thighL', sw * 0.62 - crouch * 0.70, 0, 0);
    set('shinL', Math.max(0, -sw * 0.5) + crouch * 1.05, 0, 0);
    set('thighR', swAlt * 0.62 - crouch * 0.70, 0, 0);
    set('shinR', Math.max(0, -swAlt * 0.5) + crouch * 1.05, 0, 0);
    set('footL', -sw * 0.2 - crouch * 0.38, 0, 0);
    set('footR', -swAlt * 0.2 - crouch * 0.38, 0, 0);

    // Hips absorb the gait and carry the lean.
    set('hips', crouch * 0.30, sw * 0.06, lean * 0.12);
    this.b.hips.position.y = this.rig.restWorld.hips.y - crouch * 0.42 - bob * 0.035;

    // Spine counter-rotates the hips so the torso stays facing forward, then pitches to aim.
    set('spine', pitch * 0.20 - crouch * 0.20, -sw * 0.05, lean * 0.22);
    set('chest', pitch * 0.22, -sw * 0.04, lean * 0.20);
    set('neck', pitch * 0.18, 0, lean * 0.08);
    set('head', pitch * 0.22, sw * 0.03, -lean * 0.10);

    // Arms: when aiming, both hands come to the weapon and stop swinging.
    const rest = 1 - aim;
    set('shoulderL', 0, 0, -0.05 - aim * 0.12);
    set('upperArmL', -aim * 1.28 + swAlt * 0.30 * rest, -aim * 0.30, -0.10 - aim * 0.35);
    set('forearmL', -aim * 1.02, 0, 0);
    set('shoulderR', 0, 0, 0.05 + aim * 0.12);
    set('upperArmR', -aim * 1.20 + sw * 0.30 * rest, aim * 0.22, 0.10 + aim * 0.28);
    set('forearmR', -aim * 1.15, 0, 0);
  }
}
