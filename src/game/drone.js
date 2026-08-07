/**
 * Recon drone.
 *
 * A small drivable camera the attackers deploy during preparation to find the site and
 * spot defenders. Driving it swaps the render camera rather than moving the player, so the
 * body stays where it was left and is vulnerable the whole time — the trade the genre is
 * built on.
 *
 * Deliberately noisy and fragile: it is intel, not a weapon.
 */
import * as THREE from 'three';
import { audio } from '../core/audio.js';

const RADIUS = 0.16;
const EYE = 0.20;
const ACCEL = 26;
const MAX_SPEED = 3.4;
const JUMP = 3.6;

export class Drone {
  constructor(session, owner, position) {
    this.s = session;
    this.owner = owner;
    this.alive = true;
    this.health = 12;
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = owner.controller?.yaw ?? 0;
    this.pitch = 0;
    this.grounded = false;

    this.camera = new THREE.PerspectiveCamera(88, 16 / 9, 0.02, 120);
    this.mesh = buildDroneMesh();
    this.mesh.position.copy(this.position);
    session.scene.add(this.mesh);

    this._down = new THREE.Vector3(0, -1, 0);
    this._tmp = new THREE.Vector3();
    this.spin = 0;
  }

  /** @param {object} cmd the same command object the player controller consumes */
  update(dt, cmd, driving) {
    if (!this.alive) return;

    if (driving) {
      this.yaw -= cmd.lookX;
      this.pitch = THREE.MathUtils.clamp(this.pitch - cmd.lookY, -1.0, 0.65);

      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const wish = new THREE.Vector3()
        .addScaledVector(fwd, cmd.move.y)
        .addScaledVector(right, cmd.move.x);
      if (wish.lengthSq() > 1) wish.normalize();
      wish.multiplyScalar(MAX_SPEED);

      const a = 1 - Math.exp(-ACCEL * dt);
      this.velocity.x += (wish.x - this.velocity.x) * a;
      this.velocity.z += (wish.z - this.velocity.z) * a;

      // The drone hops — that is how it gets over a windowsill or up a step.
      if (cmd.jump && this.grounded) { this.velocity.y = JUMP; this.grounded = false; }
    } else {
      this.velocity.x *= 0.86;
      this.velocity.z *= 0.86;
    }

    this.velocity.y -= 16 * dt;
    this.integrate(dt);

    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    this.spin += dt * (12 + this.velocity.length() * 4);
    for (const r of this.mesh.userData.rotors ?? []) r.rotation.y = this.spin;

    this.camera.position.copy(this.position);
    this.camera.position.y += EYE;
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);

    // Its motor is audible to everyone — the drone is not a free look.
    this._noiseIn = (this._noiseIn ?? 0) - dt;
    if (this._noiseIn <= 0 && this.velocity.lengthSq() > 0.3) {
      this._noiseIn = 0.18;
      audio.footstep({
        position: this.position, surface: 'metal', running: true,
        occlusion: audio.occlusionTo(this.s.map, this.position), gain: 0.28,
      });
    }
  }

  /** Sphere-vs-world sweep. Simpler than the player capsule, and the drone is a ball. */
  integrate(dt) {
    const step = this._tmp.copy(this.velocity).multiplyScalar(dt);
    const dist = step.length();
    if (dist > 1e-5) {
      const dir = step.clone().normalize();
      const hit = this.s.map.raycast(this.position, dir, dist + RADIUS);
      if (hit) {
        this.position.copy(hit.point).addScaledVector(hit.normal, RADIUS);
        // Bounce a little; a drone that dead-stops on every wall is miserable to drive.
        const n = hit.normal;
        this.velocity.addScaledVector(n, -1.35 * this.velocity.dot(n)).multiplyScalar(0.55);
      } else {
        this.position.add(step);
      }
    }

    const ground = this.s.map.raycast(
      this._tmp.set(this.position.x, this.position.y + 0.3, this.position.z), this._down, 0.5);
    if (ground && this.position.y - ground.point.y < RADIUS + 0.02) {
      this.position.y = ground.point.y + RADIUS;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
    } else this.grounded = false;
  }

  damage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) this.destroy();
  }

  destroy() {
    this.alive = false;
    this.s.particles.emit(this.position, 14, { color: 0x8a9099, speed: 4, life: 0.7, size: 0.04 });
    audio.impact({ position: this.position, surface: 'metal' });
    this.mesh.removeFromParent();
  }
}

function buildDroneMesh() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x2d3238, roughness: 0.5, metalness: 0.6 });
  const lens = new THREE.MeshStandardMaterial({ color: 0x0f2028, roughness: 0.08, metalness: 0.5 });
  const led = new THREE.MeshStandardMaterial({ color: 0x2f8fd0, emissive: 0x2f8fd0, emissiveIntensity: 3 });

  const hull = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 14, 10), body);
  hull.scale.set(1, 0.78, 1.1);
  g.add(hull);

  const eye = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 0.4, 10, 8), lens);
  eye.position.set(0, RADIUS * 0.16, -RADIUS * 0.95);
  g.add(eye);

  g.add(new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 0.12, 6, 5), led)
    .translateY(RADIUS * 0.7));

  // Two wheels, which is what lets it climb a sill when it hops.
  const rotors = [];
  const wheelGeo = new THREE.TorusGeometry(RADIUS * 0.92, RADIUS * 0.22, 6, 14);
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, body);
    w.rotation.y = Math.PI / 2;
    w.position.x = s * RADIUS * 0.85;
    g.add(w);
    rotors.push(w);
  }
  g.userData.rotors = rotors;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
