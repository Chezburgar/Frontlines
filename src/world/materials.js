/**
 * Surface library.
 *
 * A "surface" bundles everything the game needs to know about a material in one place: how
 * it renders, how bullets interact with it, whether it can be destroyed or reinforced, what
 * it sounds like underfoot, and what colour its debris is. Weapons, destruction, footsteps
 * and decals all read from the same table, so a wall cannot look like plaster but behave
 * like steel.
 */
import * as THREE from 'three';
import * as tex from './textures.js';

/** Destruction class — how a surface yields. */
export const BREAK = {
  NONE: 'none',        // structural; never opens up
  SOFT: 'soft',        // paper/panel: opens to any bullet, whole panel drops
  PLASTER: 'plaster',  // drywall-equivalent: bullets punch holes, breaching opens it wide
  WOOD: 'wood',        // planking: splinters, takes sustained fire
};

/**
 * Surface definitions.
 *
 * `penetration` is how many centimetres of this material a full-power rifle round will
 * pass through, used to scale damage falloff through cover.
 * `hardness` gates melee/breaching: only SOFT and PLASTER yield to a hammer.
 */
export const SURFACES = {
  tatami: {
    label: 'Tatami', break: BREAK.NONE, penetration: 4, footstep: 'soft',
    debris: 0xb8ac7a, decal: 0x6f6746, roughness: 0.93,
  },
  woodFloor: {
    label: 'Timber floor', break: BREAK.WOOD, penetration: 6, footstep: 'wood',
    debris: 0xa9855a, decal: 0x4a3722, roughness: 0.7,
  },
  woodBeam: {
    label: 'Structural timber', break: BREAK.NONE, penetration: 3, footstep: 'wood',
    debris: 0x6d4f33, decal: 0x33241a, roughness: 0.68,
  },
  shoji: {
    label: 'Shoji screen', break: BREAK.SOFT, penetration: 100, footstep: 'wood',
    debris: 0xe8e2d2, decal: 0xbdb6a4, roughness: 0.86,
  },
  fusuma: {
    label: 'Fusuma panel', break: BREAK.SOFT, penetration: 100, footstep: 'wood',
    debris: 0xc8b487, decal: 0x8a7c58, roughness: 0.8,
  },
  plaster: {
    label: 'Shikkui wall', break: BREAK.PLASTER, penetration: 14, footstep: 'stone',
    debris: 0xded7c4, decal: 0x9d977f, roughness: 0.94,
  },
  stone: {
    label: 'Stone', break: BREAK.NONE, penetration: 1, footstep: 'stone',
    debris: 0x8a8884, decal: 0x4e4c48, roughness: 0.88,
  },
  gravel: {
    label: 'Gravel', break: BREAK.NONE, penetration: 2, footstep: 'gravel',
    debris: 0xb9b3a4, decal: 0x77726a, roughness: 0.96,
  },
  roofTile: {
    label: 'Kawara tile', break: BREAK.PLASTER, penetration: 5, footstep: 'tile',
    debris: 0x55585f, decal: 0x2b2d33, roughness: 0.8,
  },
  metal: {
    label: 'Steel', break: BREAK.NONE, penetration: 0.4, footstep: 'metal',
    debris: 0x9aa0aa, decal: 0x40454d, roughness: 0.42,
  },
};

/* --------------------------------------------------------------- the library */

export class MaterialLibrary {
  constructor() {
    this.materials = new Map();
    this.maps = new Map();
    this.built = false;
  }

  /**
   * Generates every texture set once and wraps them in materials.
   * Called during load; ~10 procedural textures at 512² is well under a second.
   */
  build(anisotropy = 16) {
    if (this.built) return this;

    const mk = (name, maps, params = {}) => {
      for (const t of Object.values(maps)) if (t.isTexture) t.anisotropy = anisotropy;
      const m = new THREE.MeshStandardMaterial({
        ...maps,
        roughness: 1.0,       // modulated by the roughnessMap's green channel
        metalness: 0.0,
        dithering: true,
        ...params,
      });
      m.userData.surface = name;
      this.materials.set(name, m);
      this.maps.set(name, maps);
      return m;
    };

    mk('tatami', tex.tatamiTexture(512, 11), {});
    mk('woodFloor', tex.woodTexture(512, 5, 'warm'), {});
    mk('woodBeam', tex.darkWoodTexture(512, 47), {});
    mk('woodLight', tex.woodTexture(512, 71, 'light'), {});
    mk('plaster', tex.plasterTexture(512, 3), {});
    mk('stone', tex.stoneTexture(512, 29), {});
    mk('gravel', tex.gravelTexture(512, 53), {});
    mk('roofTile', tex.roofTileTexture(512, 23), {});
    mk('fusuma', tex.fusumaTexture(512, 37), {});
    mk('metal', tex.metalTexture(256, 59), { metalness: 0.85, roughness: 0.4 });

    // Shoji is the one surface whose whole tactical value is that light and silhouettes
    // pass through it — transmission gives that without a separate lighting hack.
    mk('shoji', tex.shojiTexture(512, 19), {
      transparent: true,
      opacity: 0.97,
      transmission: 0.55,
      thickness: 0.02,
      ior: 1.1,
      side: THREE.DoubleSide,
    });

    // Foliage and water for the courtyard garden.
    this.materials.set('foliage', new THREE.MeshStandardMaterial({
      color: 0x3f5b32, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    }));
    this.materials.set('bamboo', new THREE.MeshStandardMaterial({
      color: 0x8a9a52, roughness: 0.7, metalness: 0,
    }));
    this.materials.set('water', new THREE.MeshStandardMaterial({
      color: 0x1d3a3e, roughness: 0.08, metalness: 0.1,
      transparent: true, opacity: 0.86,
    }));
    this.materials.set('paperLamp', new THREE.MeshStandardMaterial({
      color: 0xffe6bc, emissive: 0xffb877, emissiveIntensity: 2.4, roughness: 0.9,
    }));
    this.materials.set('lacquerRed', new THREE.MeshStandardMaterial({
      color: 0x8c2b22, roughness: 0.32, metalness: 0.05,
    }));

    this.built = true;
    return this;
  }

  get(name) {
    const m = this.materials.get(name);
    if (!m) throw new Error(`unknown surface material: ${name}`);
    return m;
  }

  /**
   * A per-instance clone that keeps the shared textures but can carry its own damage
   * state — used by destructible panels so one blown wall does not blank every wall.
   */
  cloneFor(name) {
    const m = this.get(name).clone();
    m.userData.surface = name;
    return m;
  }

  /** Scales a material's UV repeat for a surface of the given world size. */
  static scaledClone(material, worldW, worldH, texelsPerMetre = 0.5) {
    const m = material.clone();
    for (const key of ['map', 'normalMap', 'roughnessMap']) {
      if (!m[key]) continue;
      const t = m[key].clone();
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(worldW * texelsPerMetre, worldH * texelsPerMetre);
      t.needsUpdate = true;
      m[key] = t;
    }
    return m;
  }

  dispose() {
    for (const m of this.materials.values()) {
      for (const k of ['map', 'normalMap', 'roughnessMap']) m[k]?.dispose?.();
      m.dispose();
    }
    this.materials.clear();
  }
}

export const surfaceOf = (name) => SURFACES[name] ?? SURFACES.plaster;
