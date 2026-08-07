/**
 * Gadgets, grenades and the objective prop.
 *
 * Everything deployable in the game lives here behind one interface: a definition
 * describing cost, cooldown and behaviour, plus a spawn function that builds its mesh and
 * registers a per-frame update. Weapons handle the shooting; this handles everything else
 * you carry.
 *
 * Models are built from primitives for the same reason the weapons are — a new gadget is a
 * data change, and nothing has to be downloaded.
 */
import * as THREE from 'three';
import { damageSurface, destroyPiece } from './combat.js';
import { BREAK } from '../world/materials.js';
import { audio } from '../core/audio.js';

export const SIDE = { ATTACK: 0, DEFEND: 1, BOTH: 2 };

/* ------------------------------------------------------------- definitions */

export const GADGETS = {
  /* ---- throwables ------------------------------------------------------- */
  frag: {
    name: 'Frag Grenade', side: SIDE.ATTACK, kind: 'throw', count: 2, cost: 300,
    fuse: 3.4, radius: 5.6, damage: 128, throwSpeed: 15,
    desc: 'Cooked on a fuse. Falls off sharply with distance and does not pass through cover.',
  },
  flash: {
    name: 'Stun Grenade', side: SIDE.BOTH, kind: 'throw', count: 3, cost: 200,
    fuse: 1.6, radius: 9, damage: 0, throwSpeed: 16, blind: 3.2,
    desc: 'Blinds anyone with line of sight to the burst, scaled by how directly they were looking at it.',
  },
  smoke: {
    name: 'Smoke Grenade', side: SIDE.BOTH, kind: 'throw', count: 2, cost: 200,
    fuse: 1.8, radius: 4.2, duration: 14, throwSpeed: 15,
    desc: 'Dense cover that blocks sight but not bullets. The only reliable way to cross the courtyard.',
  },
  impact: {
    name: 'Impact Grenade', side: SIDE.BOTH, kind: 'throw', count: 2, cost: 200,
    fuse: 0, impact: true, radius: 2.4, damage: 42, throwSpeed: 19, breachPower: 9,
    desc: 'Detonates on contact. Opens a hole in soft cover without a breach charge.',
  },
  /* ---- attacker placeables --------------------------------------------- */
  breach: {
    name: 'Breach Charge', side: SIDE.ATTACK, kind: 'place', count: 2, cost: 300,
    armTime: 0.9, fuse: 2.2, radius: 3.0, damage: 60, breachPower: 40,
    desc: 'Placed on a soft wall or hatch. Opens a full man-sized breach.',
  },
  claymore: {
    name: 'Claymore', side: SIDE.ATTACK, kind: 'place', count: 1, cost: 200,
    armTime: 1.2, radius: 4.0, damage: 150, cone: 1.2, trigger: 'proximity',
    desc: 'Directional mine covering a flank. Arms after a moment and fires once.',
  },
  drone: {
    name: 'Recon Drone', side: SIDE.ATTACK, kind: 'drone', count: 2, cost: 0,
    speed: 3.2, health: 12,
    desc: 'Drive it in to find the site and mark defenders. Fragile and audible.',
  },
  /* ---- defender placeables --------------------------------------------- */
  barbed: {
    name: 'Barbed Wire', side: SIDE.DEFEND, kind: 'place', count: 2, cost: 200,
    radius: 1.4, slow: 0.45,
    desc: 'Slows anyone crossing it and makes them loud. Denies a rush, not a push.',
  },
  shield: {
    name: 'Deployable Shield', side: SIDE.DEFEND, kind: 'place', count: 2, cost: 200,
    width: 1.3, height: 1.0, hp: 300,
    desc: 'Waist-high hard cover you can place in a doorway or across an angle.',
  },
  camera: {
    name: 'Bulletproof Camera', side: SIDE.DEFEND, kind: 'place', count: 2, cost: 200,
    desc: 'Wall-mounted eye. Survives gunfire; has to be destroyed deliberately.',
  },
  proximity: {
    name: 'Proximity Alarm', side: SIDE.DEFEND, kind: 'place', count: 2, cost: 200,
    radius: 5.0,
    desc: 'Screams when an attacker comes near. Intel, not damage.',
  },
  nitro: {
    name: 'Nitro Cell', side: SIDE.DEFEND, kind: 'place', count: 1, cost: 300,
    radius: 4.6, damage: 200, remote: true,
    desc: 'Remote-detonated charge. Lethal, and it goes through a floor.',
  },
  impactSpike: {
    name: 'Impact Spike', side: SIDE.DEFEND, kind: 'place', count: 2, cost: 150,
    radius: 3.0, damage: 55, trigger: 'proximity',
    desc: 'Cheap area denial. Triggers on an enemy inside its radius.',
  },
};

/* ------------------------------------------------------------------ models */

const MATS = {};
function mats() {
  if (MATS.built) return MATS;
  MATS.metal = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.45, metalness: 0.8 });
  MATS.dark = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.7, metalness: 0.3 });
  MATS.olive = new THREE.MeshStandardMaterial({ color: 0x4a5238, roughness: 0.8, metalness: 0.1 });
  MATS.red = new THREE.MeshStandardMaterial({ color: 0x9a2b22, roughness: 0.5, metalness: 0.2, emissive: 0x3a0806, emissiveIntensity: 1 });
  MATS.blue = new THREE.MeshStandardMaterial({ color: 0x2c5f8a, roughness: 0.5, metalness: 0.3, emissive: 0x06202f, emissiveIntensity: 1 });
  MATS.glass = new THREE.MeshStandardMaterial({ color: 0x0d1a20, roughness: 0.1, metalness: 0.5 });
  MATS.built = true;
  return MATS;
}

const box = (w, h, d, m, pos) => {
  const n = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  if (pos) n.position.set(...pos);
  return n;
};
const cyl = (r, h, m, pos, seg = 10) => {
  const n = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  if (pos) n.position.set(...pos);
  return n;
};

export function buildGadgetModel(type) {
  return buildModel(type);
}

function buildModel(type) {
  const M = mats();
  const g = new THREE.Group();
  switch (type) {
    case 'frag':
      g.add(cyl(0.032, 0.09, M.olive));
      g.add(cyl(0.012, 0.03, M.metal, [0, 0.055, 0]));
      break;
    case 'flash':
      g.add(cyl(0.028, 0.10, M.metal));
      g.add(cyl(0.032, 0.012, M.dark, [0, 0.052, 0]));
      break;
    case 'smoke':
      g.add(cyl(0.030, 0.11, M.dark));
      g.add(cyl(0.032, 0.014, M.olive, [0, 0.056, 0]));
      break;
    case 'impact':
      g.add(box(0.06, 0.07, 0.05, M.olive));
      g.add(cyl(0.010, 0.025, M.metal, [0, 0.046, 0]));
      break;
    case 'breach':
      g.add(box(0.20, 0.20, 0.035, M.olive));
      g.add(box(0.05, 0.05, 0.02, M.red, [0.06, 0.06, 0.026]));
      break;
    case 'claymore':
      g.add(box(0.18, 0.11, 0.035, M.olive));
      for (const s of [-1, 1]) g.add(box(0.012, 0.09, 0.012, M.metal, [s * 0.07, -0.09, 0]));
      g.add(box(0.03, 0.02, 0.012, M.red, [0, 0.04, 0.024]));
      break;
    case 'barbed': {
      for (let i = 0; i < 5; i++) {
        const x = -0.55 + i * 0.28;
        g.add(cyl(0.012, 0.42, M.metal, [x, 0.21, 0]));
      }
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 6;
        g.add(box(0.026, 0.026, 0.026, M.metal,
          [-0.6 + (i / 22) * 1.2, 0.14 + Math.sin(a) * 0.11, Math.cos(a) * 0.16]));
      }
      break;
    }
    case 'shield':
      g.add(box(1.3, 1.0, 0.06, M.metal, [0, 0.5, 0]));
      g.add(box(0.34, 0.22, 0.02, M.glass, [0, 0.80, 0.035]));
      for (const s of [-1, 1]) g.add(box(0.05, 0.16, 0.22, M.dark, [s * 0.55, 0.08, 0.08]));
      break;
    case 'camera':
      g.add(cyl(0.055, 0.07, M.dark, [0, 0, 0], 12));
      g.add(cyl(0.030, 0.03, M.glass, [0, 0, 0.045], 12).rotateX(Math.PI / 2));
      g.add(box(0.02, 0.02, 0.02, M.blue, [0.05, 0.03, 0.02]));
      break;
    case 'proximity':
      g.add(cyl(0.045, 0.055, M.dark, [0, 0.028, 0]));
      g.add(cyl(0.012, 0.06, M.metal, [0, 0.085, 0]));
      g.add(box(0.018, 0.018, 0.018, M.red, [0, 0.12, 0]));
      break;
    case 'nitro':
      g.add(box(0.16, 0.10, 0.09, M.dark));
      g.add(box(0.05, 0.03, 0.02, M.red, [0.04, 0.06, 0.03]));
      g.add(cyl(0.008, 0.09, M.metal, [-0.05, 0.08, 0]));
      break;
    case 'impactSpike':
      g.add(cyl(0.030, 0.13, M.metal));
      g.add(box(0.05, 0.04, 0.05, M.red, [0, 0.08, 0]));
      break;
    case 'bomb':
      // The objective. Deliberately large and lit — it has to be findable in a dark room.
      g.add(box(0.42, 0.28, 0.30, M.dark, [0, 0.14, 0]));
      g.add(box(0.34, 0.05, 0.22, M.metal, [0, 0.30, 0]));
      g.add(box(0.13, 0.09, 0.02, M.red, [0.08, 0.20, 0.16]));
      for (const s of [-1, 1]) g.add(cyl(0.018, 0.30, M.metal, [s * 0.16, 0.15, -0.12]));
      break;
    default:
      g.add(box(0.08, 0.08, 0.08, M.dark));
      break;
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/* --------------------------------------------------------------- instances */

let nextId = 1;

/**
 * A live gadget in the world.
 * `update(dt)` returns false when it should be removed.
 */
class GadgetInstance {
  constructor(system, type, def, owner, position, normal) {
    this.id = nextId++;
    this.sys = system;
    this.type = type;
    this.def = def;
    this.owner = owner;
    this.team = owner?.team ?? 0;
    this.mesh = buildModel(type);
    this.mesh.position.copy(position);
    this.age = 0;
    this.armed = false;
    this.dead = false;
    this.velocity = new THREE.Vector3();
    if (normal) {
      // Sit flush against whatever it was placed on.
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      this.mesh.quaternion.copy(q);
    }
    system.group.add(this.mesh);
  }

  remove() {
    this.dead = true;
    this.mesh.removeFromParent();
    this.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
}

/**
 * Owns every deployed gadget, the thrown projectiles, and the bomb prop.
 */
export class GadgetSystem {
  constructor(session) {
    this.s = session;
    this.group = new THREE.Group();
    this.group.name = 'gadgets';
    session.scene.add(this.group);
    this.items = [];
    this.smokes = [];
    this.bomb = null;
    this._v = new THREE.Vector3();
  }

  /* -------------------------------------------------------------- throwing */

  /** Throws a grenade from the camera along its view axis. */
  throwGrenade(type, owner, origin, direction, power = 1) {
    const def = GADGETS[type];
    if (!def) return null;
    const g = new GadgetInstance(this, type, def, owner, origin);
    g.velocity.copy(direction).normalize().multiplyScalar(def.throwSpeed * power);
    // A little lift so a flat throw still arcs.
    g.velocity.y += 1.6;
    g.thrown = true;
    g.fuse = def.fuse;
    this.items.push(g);
    return g;
  }

  /** Places a gadget on a surface the player is looking at. */
  place(type, owner, hit) {
    const def = GADGETS[type];
    if (!def || !hit) return null;
    const pos = hit.point.clone().addScaledVector(hit.normal, 0.03);
    const g = new GadgetInstance(this, type, def, owner, pos, hit.normal);
    g.surfaceHit = hit;
    g.armTimer = def.armTime ?? 0;
    this.items.push(g);
    audio.ui('confirm');
    return g;
  }

  /* ------------------------------------------------------------------ bomb */

  /** Shows the planted charge. It stays until the round ends. */
  plantBomb(position) {
    this.clearBomb();
    this.bomb = buildModel('bomb');
    this.bomb.position.copy(position);
    this.group.add(this.bomb);
    // A light on the charge so it is findable in an unlit room — the objective being
    // invisible is worse than it being slightly unrealistic.
    this.bombLight = new THREE.PointLight(0xff3322, 3.2, 7, 2);
    this.bombLight.position.copy(position).add(new THREE.Vector3(0, 0.35, 0));
    this.group.add(this.bombLight);
    return this.bomb;
  }

  clearBomb() {
    if (this.bomb) { this.bomb.removeFromParent(); this.bomb = null; }
    if (this.bombLight) { this.bombLight.removeFromParent(); this.bombLight = null; }
  }

  /* ------------------------------------------------------------------ tick */

  update(dt) {
    const map = this.s.map;

    // Pulse the charge's beacon in time with its beeping.
    if (this.bombLight) {
      const m = this.s.match;
      const frac = m.phase === 'planted' ? 1 - m.timeLeft / m.rules.fuseSeconds : 0;
      this.bombLight.intensity = 2.2 + Math.abs(Math.sin(performance.now() / 1000 * (2 + frac * 6))) * 3.5;
    }

    for (const g of this.items) {
      if (g.dead) continue;
      g.age += dt;

      // Fuse burns whether or not the grenade is still moving. Ticking it only inside the
      // in-flight branch meant anything that came to rest simply never went off.
      if (g.fuse != null && g.def.fuse > 0) {
        g.fuse -= dt;
        if (g.fuse <= 0) { this.detonate(g); continue; }
      }

      if (g.thrown) {
        // Ballistic arc with bounce.
        g.velocity.y -= 15.5 * dt;
        const step = this._v.copy(g.velocity).multiplyScalar(dt);
        const dist = step.length();
        const hit = dist > 1e-4
          ? map.raycast(g.mesh.position, step.clone().normalize(), dist + 0.05) : null;
        if (hit) {
          if (g.def.impact) { this.detonate(g); continue; }
          // Bounce with energy loss; grenades should settle, not skitter forever.
          g.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.04);
          const n = hit.normal;
          g.velocity.addScaledVector(n, -2 * g.velocity.dot(n)).multiplyScalar(0.42);
          if (g.velocity.length() < 0.6) { g.velocity.set(0, 0, 0); g.thrown = false; }
          audio.impact({ position: hit.point, surface: hit.surfaceName });
        } else {
          g.mesh.position.add(step);
        }
        g.mesh.rotateX(dt * 9); g.mesh.rotateZ(dt * 6);
        continue;
      }

      // Placed gadgets.
      if (g.armTimer > 0) {
        g.armTimer -= dt;
        if (g.armTimer <= 0) { g.armed = true; audio.ui('tick'); }
        continue;
      }

      if (g.type === 'breach') {
        g.fuse = (g.fuse ?? g.def.fuse) - dt;
        if (g.fuse <= 0) { this.detonate(g); continue; }
      }

      // Proximity triggers: claymore, impact spike, alarm.
      if (g.armed && (g.def.trigger === 'proximity' || g.type === 'proximity')) {
        const enemy = this.nearestEnemy(g);
        if (enemy) {
          if (g.type === 'proximity') {
            // Intel only, and it should not scream every frame.
            g.cooldown = (g.cooldown ?? 0) - dt;
            if (g.cooldown <= 0) {
              g.cooldown = 2.4;
              audio.bombBeep({ position: g.mesh.position, urgency: 1 });
              this.s.hud?.showBanner('PROXIMITY ALARM', '', 1200);
            }
          } else {
            this.detonate(g);
          }
        }
      }

      // Barbed wire slows whoever stands in it.
      if (g.type === 'barbed') {
        for (const p of this.s.players.values()) {
          if (!p.alive) continue;
          if (p.position.distanceTo(g.mesh.position) < g.def.radius) p.inWire = true;
        }
      }
    }

    this.items = this.items.filter((g) => !g.dead);

    // Smoke volumes expand then fade.
    for (const s of this.smokes) {
      s.age += dt;
      const grow = Math.min(1, s.age / 1.4);
      const fade = Math.max(0, 1 - Math.max(0, s.age - s.duration) / 2.5);
      s.mesh.scale.setScalar(s.radius * grow);
      s.mesh.material.opacity = 0.86 * fade;
      if (s.age > s.duration + 2.5) { s.mesh.removeFromParent(); s.dead = true; }
    }
    this.smokes = this.smokes.filter((s) => !s.dead);
  }

  nearestEnemy(g) {
    for (const p of this.s.players.values()) {
      if (!p.alive || p.team === g.team) continue;
      if (p.position.distanceTo(g.mesh.position) < (g.def.radius ?? 3)) return p;
    }
    return null;
  }

  /* -------------------------------------------------------------- detonate */

  detonate(g) {
    const pos = g.mesh.position.clone();
    const def = g.def;

    if (g.type === 'smoke') {
      this.spawnSmoke(pos, def.radius, def.duration);
      g.remove();
      return;
    }

    audio.gunshot({
      position: pos,
      weapon: { penetration: 24, loudness: 1.6 },
      occlusion: audio.occlusionTo(this.s.map, pos),
    });
    this.s.particles.emit(pos, 34, {
      color: g.type === 'flash' ? 0xffffff : 0xffa055,
      speed: 9, life: 0.5, size: 0.07,
    });
    this.s.particles.emit(pos, 22, { color: 0x33302c, speed: 5, life: 1.2, size: 0.09 });

    // Damage and blind.
    for (const p of this.s.players.values()) {
      if (!p.alive) continue;
      const d = p.position.distanceTo(pos);
      if (d > (def.radius ?? 0) * 1.6) continue;
      const eye = new THREE.Vector3(p.position.x, p.position.y + 1.5, p.position.z);
      const los = this.s.map.visible(pos, eye, 0.1);

      if (def.damage) {
        // Explosives do not pass through cover; falloff is quadratic.
        if (!los) continue;
        const t = Math.max(0, 1 - d / def.radius);
        const dmg = def.damage * t * t;
        if (dmg > 1) this.s.match.applyDamage(p, dmg, g.owner, 'body');
      }
      if (def.blind && los) {
        const t = Math.max(0, 1 - d / def.radius);
        // How directly were they facing it? A flash behind you barely registers.
        const toBlast = new THREE.Vector3().subVectors(pos, eye).normalize();
        const facing = new THREE.Vector3(-Math.sin(p.yaw ?? 0), 0, -Math.cos(p.yaw ?? 0));
        const dot = Math.max(0, facing.dot(toBlast));
        const amount = def.blind * t * (0.35 + dot * 0.65);
        if (p.local) this.s.applyFlash?.(amount);
        else p.blindUntil = performance.now() / 1000 + amount;
      }
    }

    // Surface damage — breach charges and impacts open walls.
    if (def.breachPower) {
      const hit = g.surfaceHit ?? this.s.map.raycast(
        pos, new THREE.Vector3(0, -1, 0), 0.6);
      if (hit?.piece) {
        damageSurface(this.s, hit.piece, hit.point, def.breachPower * 30);
        if (def.breachPower >= 20) destroyPiece(this.s, hit.piece);
      }
      // Also chew anything else close by.
      for (const piece of this.s.map.pieces) {
        if (piece.destroyed || piece.breakClass === BREAK.NONE) continue;
        const c = new THREE.Vector3();
        piece.mesh.geometry.computeBoundingBox();
        piece.mesh.geometry.boundingBox.getCenter(c);
        if (c.distanceTo(pos) < (def.radius ?? 2)) {
          damageSurface(this.s, piece, c, def.breachPower * 18);
        }
      }
    }

    g.remove();
  }

  spawnSmoke(position, radius, duration) {
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb8bcc2, roughness: 1, metalness: 0,
      transparent: true, opacity: 0, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, radius * 0.5, 0));
    mesh.scale.setScalar(0.01);
    this.group.add(mesh);
    this.smokes.push({ mesh, radius, duration, age: 0, position: mesh.position.clone() });
  }

  /** Does a straight line pass through live smoke? Used to gate bot vision. */
  smokeBlocks(a, b) {
    for (const s of this.smokes) {
      if (s.age < 0.5) continue;
      const r = s.radius * Math.min(1, s.age / 1.4);
      // Distance from the sphere centre to the segment.
      const ab = this._v.subVectors(b, a);
      const len = ab.length();
      if (len < 1e-4) continue;
      ab.divideScalar(len);
      const t = Math.max(0, Math.min(len, new THREE.Vector3().subVectors(s.mesh.position, a).dot(ab)));
      const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
      if (closest.distanceTo(s.mesh.position) < r) return true;
    }
    return false;
  }

  clear() {
    for (const g of this.items) g.remove();
    this.items.length = 0;
    for (const s of this.smokes) s.mesh.removeFromParent();
    this.smokes.length = 0;
    this.clearBomb();
  }
}
