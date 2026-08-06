/**
 * World container: geometry, collision and culling.
 *
 * The map is generated at load time rather than downloaded (see teahouse.js), so this
 * module's job is to take the built scene graph and make it playable: one merged BVH for
 * hitscan and capsule collision, per-object culling, and the room/spawn/objective tables
 * the match logic reads.
 *
 * Destructible pieces live outside the merged collider and are re-inserted into a second,
 * cheaply-rebuilt BVH whenever something is blown open.
 */
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { MaterialLibrary, surfaceOf } from './materials.js';
import { buildTeahouse, ROOMS, OBJECTIVES } from './teahouse.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class GameMap {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.lib = new MaterialLibrary();
    this.pieces = [];
    this.rooms = [];
    this.objectives = [];
    this.spawns = { attack: [], defend: [] };
    this.lights = [];
    this.bounds = new THREE.Box3();
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
  }

  /** Generates the map. `onProgress(fraction, label)` drives the loading bar. */
  async build(onProgress) {
    onProgress?.(0.05, 'Generating materials');
    // Yield to the event loop between phases so the loading bar actually paints.
    await frame();
    this.lib.build(16);

    onProgress?.(0.45, 'Raising Teahouse');
    await frame();
    const b = buildTeahouse(this.lib);
    this.builder = b;
    this.root.add(b.root);

    this.staticGroup = b.staticGroup;
    this.dynamicGroup = b.dynamicGroup;
    this.propGroup = b.propGroup;
    this.pieces = b.pieces;
    this.rooms = b.rooms;
    this.objectives = b.objectives;
    this.spawns = b.spawns;
    this.lights = b.lights;
    this.hatches = b.hatches;
    this.barricades = b.barricades || [];

    onProgress?.(0.72, 'Computing collision');
    await frame();
    this.rebuildCollision();

    this.bounds.setFromObject(this.root);
    onProgress?.(0.9, 'Placing objectives');
    return this;
  }

  /**
   * Rebuilds the collision BVH from every mesh currently in the world.
   *
   * Called once at load and again after destruction changes the navigable space. Merging
   * into a single triangle soup costs a rebuild, but gives one tree to traverse for every
   * bullet, footstep and capsule sweep, which is far cheaper than per-object tests across
   * a few hundred wall pieces.
   */
  rebuildCollision() {
    const positions = [];
    const owners = [];     // per-triangle back-reference for surface lookup

    const v = new THREE.Vector3();
    const collect = (group) => {
      group?.traverse((o) => {
        if (!o.isMesh || o.userData.noCollide) return;
        const piece = o.userData.piece;
        if (piece?.destroyed) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        const idx = g.index;
        o.updateWorldMatrix(true, false);
        const m = o.matrixWorld;
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i < count; i++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m);
          positions.push(v.x, v.y, v.z);
        }
        const tris = count / 3;
        for (let t = 0; t < tris; t++) owners.push(o);
      });
    };
    collect(this.staticGroup);
    collect(this.dynamicGroup);
    collect(this.propGroup);

    this._owners = owners;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.bvh = new MeshBVH(geo, { maxLeafTris: 8 });
    geo.boundsTree = this.bvh;

    if (this.collider) this.collider.geometry.dispose();
    this.collider = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    this.collider.matrixAutoUpdate = false;
    this.collider.updateMatrix();
    this.triangleCount = positions.length / 9;
  }

  /** Hitscan. Returns { point, normal, distance, mesh, piece, surface } or null. */
  raycast(origin, direction, far = 200) {
    this._ray.set(origin, direction);
    this._ray.near = 0;
    this._ray.far = far;
    const hits = this._ray.intersectObject(this.collider, false);
    if (!hits.length) return null;
    const h = hits[0];
    const mesh = this._owners?.[h.faceIndex] ?? null;
    const piece = mesh?.userData.piece ?? null;
    const surfName = piece?.surface ?? mesh?.material?.userData?.surface ?? 'plaster';
    return {
      point: h.point.clone(),
      normal: h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0),
      distance: h.distance,
      faceIndex: h.faceIndex,
      mesh, piece,
      surface: surfaceOf(surfName),
      surfaceName: surfName,
    };
  }

  /** Boolean line of sight, used by AI, audio occlusion and spectator culling. */
  visible(a, b, slack = 0.05) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    return !this.raycast(a, dir, len - slack);
  }

  /** Which room contains a world point, for callouts and the minimap. */
  roomAt(p) {
    for (const r of this.rooms) {
      const [x0, z0, x1, z1] = r.rect;
      if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1
          && p.y >= r.y - 0.6 && p.y <= r.y + 3.4) return r;
    }
    return null;
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.lib.dispose();
    this.collider?.geometry.dispose();
  }
}

/**
 * Yields to the event loop so the loading bar can repaint between build phases.
 * Deliberately not requestAnimationFrame: a backgrounded or non-compositing tab throttles
 * rAF to a stop, which would hang loading rather than merely slow it.
 */
const frame = () => new Promise((r) => setTimeout(r, 0));
