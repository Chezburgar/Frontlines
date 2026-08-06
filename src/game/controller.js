/**
 * First-person player controller.
 *
 * Movement is capsule-vs-triangle collide-and-slide against the map BVH, resolved
 * iteratively so the player slides along walls instead of sticking, and steps up stair
 * treads and thresholds without jumping. Stance (stand/crouch/prone) changes the capsule
 * height, so a crouched player genuinely fits through a window a standing one does not.
 *
 * Leaning rotates the camera about a pivot at the shoulder rather than sliding it
 * sideways, and is blocked when the lean would put the camera inside geometry — otherwise
 * players lean through walls to get free angles.
 */
import * as THREE from 'three';

export const STANCE = { STAND: 0, CROUCH: 1, PRONE: 2 };

const STANCE_DEF = {
  [STANCE.STAND]: { height: 1.78, eye: 1.63, speed: 3.35, radius: 0.32 },
  [STANCE.CROUCH]: { height: 1.22, eye: 1.06, speed: 1.75, radius: 0.32 },
  [STANCE.PRONE]: { height: 0.58, eye: 0.42, speed: 0.85, radius: 0.34 },
};

const GRAVITY = -18.5;
const JUMP_SPEED = 5.0;
const STEP_HEIGHT = 0.42;
const MAX_SLOPE_COS = Math.cos(THREE.MathUtils.degToRad(52));
const SPRINT_MULT = 1.52;
const ADS_MULT = 0.52;

/** Playable bounds. Beyond the grounds slab there is nothing to stand on. */
const BOUNDS = { x: 41, z: 37, yMin: -4, yMax: 40 };

export class PlayerController {
  constructor(map, camera, input) {
    this.map = map;
    this.camera = camera;
    this.input = input;

    this.position = new THREE.Vector3(0, 1.0, 12);
    this.velocity = new THREE.Vector3();
    this.yaw = Math.PI;
    this.pitch = 0;

    this.stance = STANCE.STAND;
    this.stanceBlend = 0;         // smoothed 0..1 toward crouch/prone
    this.grounded = false;
    this.sprinting = false;
    this.ads = 0;                 // 0..1 aim-down-sights blend
    this.lean = 0;                // -1..1 applied
    this.leanTarget = 0;
    this.speed = 0;
    this.alive = true;

    this.bobPhase = 0;
    this.bobAmount = new THREE.Vector3();
    this.recoilOffset = new THREE.Vector2();
    this.viewSway = new THREE.Vector2();

    this._tmp = new THREE.Vector3();
    this._segment = new THREE.Line3();
    this._box = new THREE.Box3();
    this._mat = new THREE.Matrix4();
    this._tri = new THREE.Vector3();
    this._cap = new THREE.Vector3();
    this._delta = new THREE.Vector3();
  }

  get def() { return STANCE_DEF[this.stance]; }

  /** Capsule for the current stance: a vertical segment plus a radius. */
  capsule(out = this._segment, pos = this.position) {
    const d = this.def;
    out.start.set(pos.x, pos.y + d.radius, pos.z);
    out.end.set(pos.x, pos.y + d.height - d.radius, pos.z);
    return out;
  }

  setStance(next) {
    if (next === this.stance) return;
    // Standing up needs headroom; refuse if something is directly above.
    if (next < this.stance && !this._fits(next)) return;
    this.stance = next;
  }

  _fits(stance) {
    const prev = this.stance;
    this.stance = stance;
    const seg = this.capsule(new THREE.Line3());
    const hit = this._sweep(seg, this.def.radius, true);
    this.stance = prev;
    return !hit;
  }

  update(dt, cmd) {
    if (!this.alive) return;
    const d = this.def;

    // ---- look ---------------------------------------------------------------
    this.yaw -= cmd.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - cmd.lookY, -1.54, 1.54);

    // ---- stance -------------------------------------------------------------
    if (cmd.prone) this.setStance(STANCE.PRONE);
    else if (cmd.crouch) this.setStance(STANCE.CROUCH);
    else this.setStance(STANCE.STAND);

    // ---- desired movement ---------------------------------------------------
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, cmd.move.y)
      .addScaledVector(right, cmd.move.x);
    if (wish.lengthSq() > 1) wish.normalize();

    // Sprint only forward, only standing, only with the weapon down.
    this.sprinting = cmd.sprint && this.stance === STANCE.STAND && cmd.move.y > 0.5 && this.ads < 0.15;

    let target = d.speed;
    if (this.sprinting) target *= SPRINT_MULT;
    target *= 1 - this.ads * (1 - ADS_MULT);
    // Strafing and backing up are slower, which is what makes peeking a commitment.
    if (cmd.move.y < -0.1) target *= 0.82;

    const wanted = wish.multiplyScalar(target);
    // Ground accelerates hard, air barely at all.
    const accel = this.grounded ? 52 : 6;
    const a = 1 - Math.exp(-accel * dt);
    this.velocity.x += (wanted.x - this.velocity.x) * a;
    this.velocity.z += (wanted.z - this.velocity.z) * a;

    if (cmd.jump && this.grounded && this.stance === STANCE.STAND) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt;
    this.velocity.y = Math.max(this.velocity.y, -55);

    // ---- integrate with collision -------------------------------------------
    this._move(this.velocity.clone().multiplyScalar(dt));

    // Hard boundary: nothing exists past the grounds, so clamp rather than let a player
    // walk into the void and fall forever.
    this.position.x = THREE.MathUtils.clamp(this.position.x, -BOUNDS.x, BOUNDS.x);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -BOUNDS.z, BOUNDS.z);
    if (this.position.y < BOUNDS.yMin) {
      // Fell out of the world (shouldn't happen, but never strand a player).
      this.position.set(0, 1.2, 12);
      this.velocity.set(0, 0, 0);
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // ---- lean ---------------------------------------------------------------
    this.leanTarget = (cmd.leanLeft ? 1 : 0) - (cmd.leanRight ? 1 : 0);
    if (this.stance === STANCE.PRONE) this.leanTarget = 0;
    if (this.leanTarget !== 0 && !this._leanClear(this.leanTarget)) this.leanTarget = 0;
    this.lean += (this.leanTarget - this.lean) * (1 - Math.exp(-11 * dt));

    // ---- ads ----------------------------------------------------------------
    const adsTarget = cmd.aim && !this.sprinting ? 1 : 0;
    this.ads += (adsTarget - this.ads) * (1 - Math.exp(-16 * dt));

    // ---- view -----------------------------------------------------------
    this.stanceBlend += ((this.stance === STANCE.STAND ? 0 : this.stance === STANCE.CROUCH ? 1 : 2) - this.stanceBlend)
      * (1 - Math.exp(-13 * dt));

    this._updateView(dt);
  }

  /** Collide-and-slide: move in sub-steps, resolving penetration each time. */
  _move(delta) {
    const d = this.def;
    // Sub-step so a fast player cannot tunnel through a wall in one frame.
    const dist = delta.length();
    const steps = Math.min(6, Math.max(1, Math.ceil(dist / (d.radius * 0.6))));
    const step = delta.divideScalar(steps);

    for (let s = 0; s < steps; s++) {
      const before = this.position.y;
      this.position.add(step);
      const res = this._resolve();

      // Step-up: if we were blocked horizontally but there is floor within the step
      // height, lift onto it. This is what makes stairs and thresholds walkable without
      // authoring ramps.
      if (res.blockedHorizontally && this.grounded) {
        const probe = this.position.clone();
        probe.y += STEP_HEIGHT;
        const saved = this.position.clone();
        this.position.copy(probe);
        const up = this._resolve();
        if (!up.blockedHorizontally) {
          // Settle back down onto the step.
          this.position.y -= STEP_HEIGHT * 0.5;
          this._resolve();
        } else {
          this.position.copy(saved);
        }
      }
      if (this.position.y > before + 2) break;   // safety against runaway resolution
    }
  }

  /**
   * Pushes the capsule out of any triangle it overlaps.
   * Returns whether the resolution was mostly horizontal (a wall) and updates `grounded`.
   */
  _resolve() {
    const bvh = this.map.bvh;
    if (!bvh) return { blockedHorizontally: false };
    const d = this.def;
    const radius = d.radius;

    let blockedHorizontally = false;
    let groundedNow = false;

    for (let iter = 0; iter < 4; iter++) {
      const seg = this.capsule(this._segment);
      this._box.makeEmpty();
      this._box.expandByPoint(seg.start);
      this._box.expandByPoint(seg.end);
      this._box.min.addScalar(-radius);
      this._box.max.addScalar(radius);

      let hit = false;
      const push = new THREE.Vector3();

      bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(this._box),
        intersectsTriangle: (tri) => {
          const triPoint = this._tri, capPoint = this._cap;
          const dist = tri.closestPointToSegment(seg, triPoint, capPoint);
          if (dist < radius) {
            const depth = radius - dist;
            const dir = this._delta.subVectors(capPoint, triPoint);
            if (dir.lengthSq() < 1e-12) return;
            dir.normalize();
            push.addScaledVector(dir, depth);
            hit = true;
            if (dir.y > MAX_SLOPE_COS) groundedNow = true;
            else if (Math.abs(dir.y) < 0.6) blockedHorizontally = true;
          }
        },
      });

      if (!hit) break;
      // Damp the accumulated push so overlapping triangles don't launch the player.
      if (push.length() > 0.5) push.setLength(0.5);
      this.position.add(push);

      // Kill velocity into the surface we just resolved against.
      const n = push.clone().normalize();
      const into = this.velocity.dot(n);
      if (into < 0) this.velocity.addScaledVector(n, -into);
    }

    // Ground check: a short downward probe keeps `grounded` stable on slopes and steps.
    if (!groundedNow) groundedNow = this._groundProbe();
    this.grounded = groundedNow;
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    return { blockedHorizontally };
  }

  _groundProbe() {
    const d = this.def;
    const origin = this._tmp.set(this.position.x, this.position.y + 0.12, this.position.z);
    const hit = this.map.raycast(origin, DOWN, 0.30);
    if (!hit) return false;
    // Snap to the surface so walking down stairs doesn't chatter between grounded states.
    if (hit.distance < 0.28) this.position.y = hit.point.y;
    return true;
  }

  /** Is there room to lean this way, or would the camera end up inside a wall? */
  _leanClear(dir) {
    const eye = this.eyePosition(new THREE.Vector3(), dir);
    const from = this._tmp.set(this.position.x, eye.y, this.position.z);
    const to = eye;
    const delta = new THREE.Vector3().subVectors(to, from);
    const len = delta.length();
    if (len < 1e-4) return true;
    delta.divideScalar(len);
    return !this.map.raycast(from, delta, len + 0.14);
  }

  /** World-space eye position for a given lean amount (defaults to the current lean). */
  eyePosition(out = new THREE.Vector3(), leanOverride = null) {
    const d = this.def;
    const lean = leanOverride ?? this.lean;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.copy(this.position);
    out.y += d.eye;
    // Lean pivots about the shoulder: the head swings out and drops a little.
    out.addScaledVector(right, -lean * 0.55);
    out.y -= Math.abs(lean) * 0.10;
    return out;
  }

  _updateView(dt) {
    const cam = this.camera;
    const eye = this.eyePosition(this._tmp.clone());

    // Head bob, scaled by speed and killed while aiming.
    if (this.grounded && this.speed > 0.3) {
      this.bobPhase += dt * (5.0 + this.speed * 1.5);
    }
    const bobScale = (this.speed / 3.4) * (1 - this.ads * 0.85);
    this.bobAmount.set(
      Math.cos(this.bobPhase) * 0.022 * bobScale,
      Math.abs(Math.sin(this.bobPhase)) * 0.028 * bobScale,
      0,
    );

    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    eye.addScaledVector(right, this.bobAmount.x);
    eye.y += this.bobAmount.y;

    cam.position.copy(eye);
    cam.rotation.set(0, 0, 0, 'YXZ');
    cam.rotateY(this.yaw);
    cam.rotateX(this.pitch + this.recoilOffset.y);
    // Camera roll sells the lean far more than the translation does.
    cam.rotateZ(this.lean * 0.20 - this.bobAmount.x * 0.6);

    this.recoilOffset.multiplyScalar(Math.exp(-9 * dt));
  }

  /** Applies recoil kick to the view; weapons call this on fire. */
  addRecoil(pitchKick, yawKick) {
    this.pitch += pitchKick;
    this.yaw += yawKick;
    this.recoilOffset.y += pitchKick * 0.35;
  }

  teleport(x, y, z, yaw = this.yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
