/**
 * Bot opponents.
 *
 * Deliberately simple and readable rather than clever: bots pick a goal from the round
 * state, walk toward it along straight segments with wall avoidance, and engage anything
 * they can see. The point is a match that plays end to end solo — and a moving, shooting
 * target set to tune weapon feel against — not a convincing human.
 *
 * They share the player's combat resolution, so their bullets penetrate, break shoji and
 * register hit zones exactly like yours do.
 */
import * as THREE from 'three';
import { WeaponInstance } from './weapons.js';
import { fireRound, damageSurface } from './combat.js';
import { PHASE, TEAM } from './match.js';

const LOADOUTS = [
  { id: 'ar556', attach: { sight: 'reflex', barrel: 'compensator', grip: 'vertical', under: 'none' } },
  { id: 'k1a', attach: { sight: 'holo', barrel: 'none', grip: 'angled', under: 'none' } },
  { id: 'mp5k', attach: { sight: 'reflex', barrel: 'suppressor', grip: 'vertical', under: 'none' } },
  { id: 'm870', attach: { sight: 'none', barrel: 'none', grip: 'none', under: 'none' } },
];

const SIGHT_RANGE = 42;
const FOV_COS = Math.cos(THREE.MathUtils.degToRad(62));
const WALK = 2.5;
const ENGAGE_WALK = 1.5;

export class BotBrain {
  constructor(session, player) {
    this.s = session;
    this.p = player;
    this.weapon = new WeaponInstance(
      LOADOUTS[(player.slot ?? 0) % LOADOUTS.length].id,
      LOADOUTS[(player.slot ?? 0) % LOADOUTS.length].attach,
    );
    this.target = null;
    this.goal = null;
    this.reactTimer = 0;
    this.burst = 0;
    this.repathIn = 0;
    this.aimError = new THREE.Vector2();
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 0;
    // Per-bot skill so a lobby is not uniformly lethal.
    this.skill = 0.45 + Math.random() * 0.4;
    this._dir = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._tEye = new THREE.Vector3();
  }

  get eye() {
    return this._eye.set(this.p.position.x, this.p.position.y + 1.58, this.p.position.z);
  }

  update(dt) {
    const p = this.p;
    if (!p.alive) { p.speed = 0; return; }
    const m = this.s.match;
    if (m.phase === PHASE.ENDED || m.phase === PHASE.MATCH_OVER) { p.speed = 0; return; }
    // Preparation is not a fight. Bots hold their spawn, look around, and do not shoot —
    // attackers are outside setting up and defenders are fortifying.
    if (m.phase === PHASE.PREP) {
      this.target = null;
      this.p.aiming = false;
      this.p.speed = 0;
      this.p.yaw = (this.p.yaw ?? 0) + Math.sin(m.timeLeft * 0.6 + this.skill * 9) * dt * 0.35;
      return;
    }

    this.weapon.update(dt);
    this.acquire(dt);

    if (this.target) this.fight(dt);
    else this.advance(dt);

    this.integrate(dt);
  }

  /* --------------------------------------------------------------- targeting */

  acquire(dt) {
    // Re-check the current target's validity every frame, but only scan for a new one
    // periodically — a full LOS sweep per bot per frame is the expensive part.
    if (this.target && (!this.target.alive || !this.canSee(this.target))) this.target = null;
    this.scanIn = (this.scanIn ?? 0) - dt;
    if (this.target || this.scanIn > 0) return;
    this.scanIn = 0.18 + Math.random() * 0.14;

    let best = null, bestD = SIGHT_RANGE;
    for (const other of this.s.players.values()) {
      if (other === this.p || !other.alive) continue;
      if (other.team === this.p.team) continue;
      const d = this.p.position.distanceTo(other.position);
      if (d > bestD) continue;
      if (!this.canSee(other)) continue;
      best = other; bestD = d;
    }
    if (best) {
      this.target = best;
      // Reaction time before the first shot, scaled by skill.
      this.reactTimer = 0.34 - this.skill * 0.20 + Math.random() * 0.12;
      this.burst = 0;
    }
  }

  canSee(other) {
    const from = this.eye;
    const to = this._tEye.set(other.position.x, other.position.y + 1.35, other.position.z);
    const d = this._dir.subVectors(to, from);
    const dist = d.length();
    if (dist > SIGHT_RANGE) return false;
    d.divideScalar(dist);
    // Field of view gate, so bots cannot see behind themselves.
    const facing = new THREE.Vector3(-Math.sin(this.p.yaw ?? 0), 0, -Math.cos(this.p.yaw ?? 0));
    if (facing.dot(d) < FOV_COS) return false;
    return this.s.map.visible(from, to, 0.2);
  }

  /* ------------------------------------------------------------------ combat */

  fight(dt) {
    const t = this.target;
    const to = this._tEye.set(t.position.x, t.position.y + 1.35, t.position.z);
    const from = this.eye;
    const want = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    const wantPitch = Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));

    // Turn toward the target at a rate the skill setting controls.
    const turn = (6.0 + this.skill * 8.0) * dt;
    this.p.yaw = approachAngle(this.p.yaw ?? 0, want, turn);
    this.p.pitch = THREE.MathUtils.lerp(this.p.pitch ?? 0, wantPitch, Math.min(1, turn));
    this.p.aiming = true;

    // Sidestep so bots are not static targets.
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) { this.strafe *= -1; this.strafeTimer = 0.7 + Math.random() * 1.1; }
    const right = new THREE.Vector3(Math.cos(this.p.yaw), 0, -Math.sin(this.p.yaw));
    const dist = this.p.position.distanceTo(t.position);
    const forward = new THREE.Vector3(-Math.sin(this.p.yaw), 0, -Math.cos(this.p.yaw));
    this.move = new THREE.Vector3()
      .addScaledVector(right, this.strafe * 0.8)
      .addScaledVector(forward, dist > 12 ? 0.7 : dist < 5 ? -0.4 : 0)
      .normalize().multiplyScalar(ENGAGE_WALK);

    if (this.reactTimer > 0) { this.reactTimer -= dt; return; }

    if (this.weapon.empty) { this.weapon.startReload(); return; }
    if (this.weapon.reloading > 0) return;

    // Only shoot once roughly on target, otherwise bots hose walls.
    const aimOff = Math.abs(angleDelta(this.p.yaw, want));
    if (aimOff > 0.10) return;

    const now = performance.now() / 1000;
    if (this.weapon.tryFire(now, true, true)) {
      this.burst++;
      this.shoot(t);
      // Burst discipline: pause after a few rounds so bots are beatable.
      if (this.burst >= 3 + Math.floor(this.skill * 5)) {
        this.weapon.cooldown += 0.20 + (1 - this.skill) * 0.35;
        this.burst = 0;
      }
    }
  }

  shoot(target) {
    const from = this.eye.clone();
    const to = new THREE.Vector3(target.position.x, target.position.y + 1.30, target.position.z);
    const dir = to.sub(from).normalize();

    // Inaccuracy shrinks with skill and grows with the target's speed.
    const spread = (1 - this.skill) * 0.055 + Math.min(0.03, (target.speed ?? 0) * 0.008);
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

    const res = fireRound(this.s, from, dir, this.weapon.def, this.p);
    for (const h of res.hits) {
      if (h.kind === 'surface') {
        this.s.impacts.add(h.point, h.normal, h.surface);
        if (h.piece) damageSurface(this.s, h.piece, h.point, (this.weapon.def.breachPower ?? 1) * 30);
      } else if (h.kind === 'player') {
        this.s.particles.emit(h.point, 5, { color: 0x8c1f18, speed: 2.0, life: 0.4, size: 0.024 });
        this.s.match.applyDamage(h.target, h.damage, this.p, h.zone);
      }
    }
    this.s.flashAt?.(from, dir, this.weapon.def);
  }

  /* ---------------------------------------------------------------- movement */

  advance(dt) {
    const m = this.s.match;
    this.p.aiming = false;
    this.repathIn -= dt;

    if (!this.goal || this.repathIn <= 0 || this.p.position.distanceTo(this.goal) < 1.6) {
      this.goal = this.pickGoal();
      this.repathIn = 3.5 + Math.random() * 3;
    }
    if (!this.goal) { this.move = new THREE.Vector3(); this.p.speed = 0; return; }

    const to = new THREE.Vector3().subVectors(this.goal, this.p.position);
    to.y = 0;
    const dist = to.length();
    if (dist < 0.2) { this.move = new THREE.Vector3(); return; }
    to.divideScalar(dist);

    // Whisker avoidance: probe ahead and to both sides, steer away from what is closest.
    const probe = (angle) => {
      const d = to.clone().applyAxisAngle(UP, angle);
      const hit = this.s.map.raycast(this.eye, d, 2.4);
      return hit ? hit.distance : 2.4;
    };
    const c = probe(0), l = probe(0.6), r = probe(-0.6);
    if (c < 1.4) to.applyAxisAngle(UP, l > r ? 0.9 : -0.9);
    else if (l < 1.0) to.applyAxisAngle(UP, -0.5);
    else if (r < 1.0) to.applyAxisAngle(UP, 0.5);

    this.move = to.multiplyScalar(WALK);
    const want = Math.atan2(-to.x, -to.z);
    this.p.yaw = approachAngle(this.p.yaw ?? 0, want, 5 * dt);
    this.p.pitch = THREE.MathUtils.lerp(this.p.pitch ?? 0, 0, 3 * dt);
  }

  pickGoal() {
    const m = this.s.match;
    const side = m.sideOf[this.p.team];
    const rooms = this.s.map.rooms;
    if (!rooms?.length) return null;

    // Attackers converge on the objective; defenders hold near it but spread out.
    if (m.site) {
      const siteRooms = rooms.filter((r) => m.site.rooms.includes(r.id));
      if (siteRooms.length) {
        const r = siteRooms[Math.floor(Math.random() * siteRooms.length)];
        const spread = side === TEAM.ATTACK ? 2.5 : 4.5;
        return new THREE.Vector3(
          (r.rect[0] + r.rect[2]) / 2 + (Math.random() - 0.5) * spread * 2,
          r.y,
          (r.rect[1] + r.rect[3]) / 2 + (Math.random() - 0.5) * spread * 2,
        );
      }
    }
    const r = rooms[Math.floor(Math.random() * rooms.length)];
    return new THREE.Vector3(
      (r.rect[0] + r.rect[2]) / 2, r.y, (r.rect[1] + r.rect[3]) / 2,
    );
  }

  /**
   * Moves the bot, resolving against the world.
   * Bots use a cheap horizontal probe rather than the full capsule solver — they never
   * jump or vault, so a sweep plus a floor snap is enough and costs a fraction as much.
   */
  integrate(dt) {
    const p = this.p;
    const move = this.move ?? new THREE.Vector3();
    if (move.lengthSq() < 1e-6) { p.speed = 0; return; }

    const step = move.clone().multiplyScalar(dt);
    const dist = step.length();
    const dir = step.clone().normalize();
    const hit = this.s.map.raycast(
      new THREE.Vector3(p.position.x, p.position.y + 0.9, p.position.z), dir, dist + 0.45);
    if (!hit) {
      p.position.add(step);
    } else {
      // Slide along the surface instead of stopping dead against it.
      const n = hit.normal.clone(); n.y = 0; n.normalize();
      const slide = step.clone().addScaledVector(n, -step.dot(n));
      const h2 = this.s.map.raycast(
        new THREE.Vector3(p.position.x, p.position.y + 0.9, p.position.z),
        slide.clone().normalize(), slide.length() + 0.4);
      if (!h2) p.position.add(slide);
    }

    // Snap to the floor beneath.
    const ground = this.s.map.raycast(
      new THREE.Vector3(p.position.x, p.position.y + 1.2, p.position.z), DOWN, 4.0);
    if (ground) p.position.y = ground.point.y;

    p.speed = move.length();
  }
}

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function approachAngle(a, b, maxStep) {
  const d = angleDelta(a, b);
  return a + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
