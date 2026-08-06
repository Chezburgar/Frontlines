/**
 * Map loading, collision and culling.
 *
 * The map ships as ~69 spatial chunks across three storey meshes. That layout exists so
 * this module can do three things cheaply:
 *   - frustum-cull per chunk instead of per storey (interiors occlude enormously),
 *   - build one merged BVH for hitscan and capsule collision,
 *   - stream shadow casting only for chunks near the viewer.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Physical surface classes drive footstep audio, bullet decals and penetration. */
export const SURFACE = {
  CONCRETE: 0, WOOD: 1, METAL: 2, GLASS: 3, FABRIC: 4, DIRT: 5,
};

export class GameMap {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'map';
    this.chunks = [];          // { mesh, bounds, storey }
    this.collider = null;      // merged BVH mesh
    this.nav = null;
    this.bounds = new THREE.Box3();
    this.storeys = [];
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
  }

  async load(url, navUrl, onProgress) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await new Promise((res, rej) =>
      loader.load(url, res, (e) => onProgress?.(e.loaded / (e.total || 1)), rej));

    const positions = [];
    let vertexTotal = 0;

    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      o.geometry.computeBoundingSphere();
      o.castShadow = true;
      o.receiveShadow = true;
      o.matrixAutoUpdate = false;
      o.updateMatrix();

      const storey = o.name.startsWith('f2') ? 1 : o.name.startsWith('f3') ? 2 : 0;
      const box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      this.chunks.push({ mesh: o, bounds: box, storey, sphere: o.geometry.boundingSphere.clone() });
      this.bounds.union(box);

      // Accumulate world-space triangles for the collision BVH.
      const g = o.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const m = o.matrixWorld;
      const v = new THREE.Vector3();
      if (idx) {
        for (let i = 0; i < idx.count; i++) {
          v.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(m);
          positions.push(v.x, v.y, v.z);
        }
      } else {
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          positions.push(v.x, v.y, v.z);
        }
      }
      vertexTotal += pos.count;
    });

    this.root.add(gltf.scene);
    this.tuneMaterials();

    // ---- collision BVH ------------------------------------------------------
    const colGeo = new THREE.BufferGeometry();
    colGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.bvh = new MeshBVH(colGeo, { maxLeafTris: 8, strategy: 0 });
    colGeo.boundsTree = this.bvh;
    this.collider = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({ visible: false }));
    this.collider.geometry.boundsTree = this.bvh;
    this.collider.matrixAutoUpdate = false;
    this.collider.updateMatrix();

    this.triangleCount = positions.length / 9;
    this.vertexCount = vertexTotal;

    if (navUrl) {
      try {
        this.nav = await (await fetch(navUrl)).json();
        this.storeys = this.nav.storeys || [];
      } catch { /* nav data is an optimisation, not a requirement */ }
    }

    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = true;
    return this;
  }

  /**
   * The source atlases are baked-diffuse only — no normal, roughness or AO maps — so the
   * PBR response has to be authored here or everything reads as flat matte cardboard.
   * Roughness is derived per-material and a subtle detail normal is generated procedurally
   * to give surfaces micro-structure under the flashlight and muzzle flash.
   */
  tuneMaterials() {
    const detail = makeDetailNormal();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map) {
          m.map.anisotropy = 16;
          m.map.colorSpace = THREE.SRGBColorSpace;
          m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
          m.map.needsUpdate = true;
        }
        m.roughness = 0.86;
        m.metalness = 0.0;
        m.envMapIntensity = 0.9;
        m.normalMap = detail;
        m.normalScale = new THREE.Vector2(0.28, 0.28);
        m.side = THREE.DoubleSide;
        m.shadowSide = THREE.FrontSide;
        m.dithering = true;
        m.needsUpdate = true;
      }
    });
  }

  /** Per-chunk frustum culling. Cheaper and far more effective than three's per-object pass. */
  updateCulling(camera) {
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);
    let visible = 0;
    for (const c of this.chunks) {
      const v = this._frustum.intersectsBox(c.bounds);
      c.mesh.visible = v;
      if (v) visible++;
    }
    this.visibleChunks = visible;
    return visible;
  }

  /** Only chunks near the camera need to cast shadows; the rest are pure cost. */
  updateShadowCasters(position, radius) {
    const r2 = radius * radius;
    for (const c of this.chunks) {
      const d = c.bounds.distanceToPoint(position);
      c.mesh.castShadow = d * d < r2;
    }
  }

  /** Hitscan against the merged collider. Returns { point, normal, distance } or null. */
  raycast(origin, direction, far = 200) {
    this._raycaster.set(origin, direction);
    this._raycaster.far = far;
    this._raycaster.near = 0;
    const hits = this._raycaster.intersectObject(this.collider, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      point: h.point,
      normal: h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0),
      distance: h.distance,
      faceIndex: h.faceIndex,
    };
  }

  /** Cheap boolean line-of-sight test used by AI, audio occlusion and spectator culling. */
  visible(a, b) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    const hit = this.raycast(a, dir, len - 0.05);
    return !hit;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { m.map?.dispose(); m.dispose(); });
      }
    });
    this.collider?.geometry.dispose();
  }
}

/**
 * Procedural detail normal map.
 * A band-limited value-noise field, differentiated to a tangent-space normal. Tiles at 512
 * and is repeated heavily, so it reads as plaster/concrete grain rather than a visible
 * pattern. Generating it beats shipping a texture and lets the scale be tuned per surface.
 */
function makeDetailNormal(size = 512) {
  const rand = mulberry32(0x5eed);
  const octaves = [
    { freq: 4, amp: 1.0 },
    { freq: 9, amp: 0.55 },
    { freq: 19, amp: 0.28 },
    { freq: 41, amp: 0.14 },
  ];
  const grids = octaves.map((o) => {
    const n = o.freq;
    const g = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = rand();
    return g;
  });

  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (g, n, x, y) => {
    const fx = x * n, fy = y * n;
    const x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const tx = smooth(fx - Math.floor(fx)), ty = smooth(fy - Math.floor(fy));
    const a = g[y0 * n + x0], b = g[y0 * n + x1], c = g[y1 * n + x0], d = g[y1 * n + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0, norm = 0;
      for (let o = 0; o < octaves.length; o++) {
        h += sample(grids[o], octaves[o].freq, x / size, y / size) * octaves[o].amp;
        norm += octaves[o].amp;
      }
      height[y * size + x] = h / norm;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const S = 2.4;   // slope gain
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      let nx = (l - r) * S, ny = (u - d) * S, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(48, 48);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
