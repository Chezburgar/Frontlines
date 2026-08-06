/**
 * Combat resolution: bullets, penetration, destruction and impact effects.
 *
 * A shot marches through the world rather than stopping at the first hit. Each surface it
 * meets spends part of the round's penetration budget (in cm of concrete-equivalent) and
 * scales the damage that continues behind it. That single mechanism gives wallbangs,
 * shooting through shoji, and the "soft wall vs hard wall" read the map is built around.
 *
 * Destruction is driven from the same numbers: a surface's break class decides whether
 * hits punch holes, splinter, or do nothing at all.
 */
import * as THREE from 'three';
import { BREAK } from '../world/materials.js';
import { damageAtRange } from './weapons.js';

const MAX_PENETRATIONS = 4;
const MAX_RANGE = 120;

/* ------------------------------------------------------------------ tracing */

/**
 * Fires one round.
 * @returns {{ hits: Array, path: Array<THREE.Vector3>, killed: Array }}
 */
export function fireRound(world, origin, direction, weapon, shooter, opts = {}) {
  const path = [origin.clone()];
  const hits = [];
  let budget = weapon.penetration;
  let damageScale = 1;
  let travelled = 0;

  const pos = origin.clone();
  const dir = direction.clone().normalize();

  for (let bounce = 0; bounce < MAX_PENETRATIONS; bounce++) {
    // Players first: a body between the muzzle and the wall takes the round.
    const playerHit = raycastPlayers(world, pos, dir, MAX_RANGE - travelled, shooter);
    const surfHit = world.map.raycast(pos, dir, MAX_RANGE - travelled);

    // Whichever is nearer wins this segment.
    if (playerHit && (!surfHit || playerHit.distance < surfHit.distance)) {
      travelled += playerHit.distance;
      path.push(playerHit.point.clone());
      const base = damageAtRange(weapon, travelled) * damageScale;
      const mult = playerHit.zone === 'head' ? weapon.headMult
        : playerHit.zone === 'limb' ? weapon.limbMult : 1;
      hits.push({ kind: 'player', target: playerHit.target, zone: playerHit.zone,
                  damage: base * mult, point: playerHit.point.clone(), distance: travelled });
      // Rounds do not continue through bodies in this game — one target per round keeps
      // damage attribution unambiguous, which matters a lot for a 5v5 with no respawns.
      break;
    }

    if (!surfHit) {
      path.push(pos.clone().addScaledVector(dir, MAX_RANGE - travelled));
      break;
    }

    travelled += surfHit.distance;
    path.push(surfHit.point.clone());

    const surface = surfHit.surface;
    hits.push({ kind: 'surface', point: surfHit.point.clone(), normal: surfHit.normal.clone(),
                surface, surfaceName: surfHit.surfaceName, piece: surfHit.piece, distance: travelled });

    // Spend the penetration budget. `penetration` on the surface is the cm of
    // concrete-equivalent one pass costs.
    const cost = surface.penetration;
    if (cost >= budget) break;                 // round stops here
    budget -= cost;
    // Damage behind cover falls off with how much of the budget the wall ate.
    damageScale *= Math.max(0.15, 1 - cost / weapon.penetration);

    // Step just past the surface and continue.
    pos.copy(surfHit.point).addScaledVector(dir, 0.06);
  }

  return { hits, path, budget };
}

/** Capsule-vs-ray against every living player except the shooter. */
function raycastPlayers(world, origin, dir, far, shooter) {
  let best = null;
  for (const p of world.players.values()) {
    if (p === shooter || !p.alive) continue;
    const hit = rayCapsule(origin, dir, p, far);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

const _seg = new THREE.Vector3();
const _toStart = new THREE.Vector3();

/**
 * Ray against an upright capsule, plus a smaller sphere for the head.
 * Hit zones: head, body, limb — limb is the outer shell of the body capsule, which
 * approximates arms and legs without needing per-bone colliders.
 */
function rayCapsule(origin, dir, player, far) {
  const h = player.height ?? 1.78;
  const r = player.radius ?? 0.32;
  const base = player.position;

  // Head sphere sits at eye height.
  const headC = _seg.set(base.x, base.y + h - 0.14, base.z);
  const headHit = raySphere(origin, dir, headC, 0.135, far);

  // Body capsule from knee to shoulder.
  const bodyHit = rayVerticalCapsule(origin, dir, base.x, base.z, base.y + r, base.y + h - 0.28, r, far);

  if (headHit && (!bodyHit || headHit < bodyHit)) {
    return { target: player, zone: 'head', distance: headHit,
             point: origin.clone().addScaledVector(dir, headHit) };
  }
  if (bodyHit != null) {
    const point = origin.clone().addScaledVector(dir, bodyHit);
    // Off-axis hits count as limbs.
    const dx = point.x - base.x, dz = point.z - base.z;
    const radial = Math.hypot(dx, dz);
    const zone = radial > r * 0.62 || point.y < base.y + 0.75 ? 'limb' : 'body';
    return { target: player, zone, distance: bodyHit, point };
  }
  return null;
}

function raySphere(o, d, c, r, far) {
  _toStart.subVectors(o, c);
  const b = _toStart.dot(d);
  const cc = _toStart.lengthSq() - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= far ? t : null;
}

function rayVerticalCapsule(o, d, cx, cz, y0, y1, r, far) {
  // Infinite cylinder in XZ, then clamp to the segment and cap with spheres.
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-8) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= far) {
        const y = o.y + d.y * t;
        if (y >= y0 && y <= y1) return t;
      }
    }
  }
  const capA = raySphere(o, d, new THREE.Vector3(cx, y0, cz), r, far);
  const capB = raySphere(o, d, new THREE.Vector3(cx, y1, cz), r, far);
  if (capA != null && capB != null) return Math.min(capA, capB);
  return capA ?? capB;
}

/* -------------------------------------------------------------- destruction */

/**
 * Applies damage to a destructible piece.
 * Soft surfaces (paper, thin panel) drop whole on any hit. Plaster and wood accumulate
 * damage and open a hole once a local region is spent.
 */
export function damageSurface(world, piece, point, amount, radius = 0.16) {
  if (!piece || piece.destroyed || piece.breakClass === BREAK.NONE) return false;
  if (piece.reinforced) return false;

  if (piece.breakClass === BREAK.SOFT) {
    destroyPiece(world, piece);
    return true;
  }

  piece.health -= amount;
  piece.holes.push({ x: point.x, y: point.y, z: point.z, r: radius });

  // Enough holes close together and the panel gives way entirely.
  if (piece.health <= 0) {
    destroyPiece(world, piece);
    return true;
  }
  // Visual feedback short of destruction: darken and roughen as it takes damage.
  const t = 1 - piece.health / piece.maxHealth;
  const m = piece.mesh.material;
  if (m && m.color) m.color.setScalar(1 - t * 0.35);
  return false;
}

export function destroyPiece(world, piece) {
  if (piece.destroyed) return;
  piece.destroyed = true;
  piece.mesh.visible = false;
  piece.mesh.userData.noCollide = true;
  world.destroyedThisTick = true;
  world.onPieceDestroyed?.(piece);
}

/** Reinforces a piece so it can no longer be breached by gunfire. */
export function reinforcePiece(piece) {
  if (!piece || !piece.reinforceable || piece.reinforced || piece.destroyed) return false;
  piece.reinforced = true;
  const m = piece.mesh.material;
  if (m) { m.color?.set(0x6b7076); m.metalness = 0.75; m.roughness = 0.42; }
  return true;
}

/* ------------------------------------------------------------------ effects */

/**
 * Impact decals and debris.
 *
 * Decals are pooled into a single InstancedMesh per surface family so a whole match's
 * worth of bullet holes costs one draw call, and the oldest are recycled once the pool
 * is full rather than growing without bound.
 */
export class ImpactSystem {
  constructor(scene, capacity = 512) {
    this.capacity = capacity;
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a1714, roughness: 0.95, metalness: 0,
      transparent: true, opacity: 0.92,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.colors = new Float32Array(capacity * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    scene.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
    this._scale = new THREE.Vector3();
    this._col = new THREE.Color();
  }

  add(point, normal, surface, size = 0.09) {
    const i = this.cursor % this.capacity;
    this.cursor++;
    this.mesh.count = Math.min(this.cursor, this.capacity);

    this._q.setFromUnitVectors(this._up, normal);
    const s = size * (0.7 + Math.random() * 0.7);
    this._scale.set(s, s, s);
    // Offset slightly along the normal so the decal never z-fights its wall.
    const p = point.clone().addScaledVector(normal, 0.006);
    this._m.compose(p, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);

    this._col.setHex(surface?.decal ?? 0x2a2724);
    this.colors[i * 3] = this._col.r;
    this.colors[i * 3 + 1] = this._col.g;
    this.colors[i * 3 + 2] = this._col.b;

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.cursor = 0; this.mesh.count = 0; }
}

/**
 * Particle bursts for impacts, muzzle flash and blood.
 * One pooled points cloud, integrated on the CPU — at a few hundred live particles that is
 * cheaper than the bookkeeping a GPU system would need for this scale.
 */
export class ParticleSystem {
  constructor(scene, capacity = 900) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 320.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.12, length(d));
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.geo = geo;
  }

  emit(origin, count, { color = 0xbbaa99, speed = 3, spread = 1, life = 0.6, size = 0.03, gravity = true } = {}) {
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor % this.capacity;
      this.cursor++;
      this.positions[i * 3] = origin.x;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z;
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2,
      ).normalize().multiplyScalar(speed * (0.4 + Math.random() * spread));
      this.velocities[i * 3] = dir.x;
      this.velocities[i * 3 + 1] = dir.y;
      this.velocities[i * 3 + 2] = dir.z;
      const v = 0.75 + Math.random() * 0.5;
      this.colors[i * 3] = c.r * v;
      this.colors[i * 3 + 1] = c.g * v;
      this.colors[i * 3 + 2] = c.b * v;
      this.sizes[i] = size * (0.6 + Math.random() * 0.8);
      this.life[i] = life * (0.7 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.gravity = gravity;
    }
  }

  update(dt) {
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) { this.sizes[i] = 0; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.sizes[i] = 0; continue; }
      this.velocities[i * 3 + 1] -= 9.5 * dt;
      this.velocities[i * 3] *= 0.97;
      this.velocities[i * 3 + 2] *= 0.97;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      // Fade by shrinking, which reads better than alpha for small debris.
      this.sizes[i] *= 0.5 + 0.5 * (this.life[i] / this.maxLife[i]);
      live++;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.liveCount = live;
  }
}
