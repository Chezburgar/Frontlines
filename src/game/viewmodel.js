/**
 * First-person weapon viewmodel.
 *
 * Weapons are built procedurally from a parts description — receiver, barrel, handguard,
 * stock, magazine, optic — so a new weapon is a data change and every attachment the
 * loadout system offers actually appears on the model.
 *
 * The viewmodel renders in its own pass with a narrow FOV and its own near plane, which is
 * what stops the gun clipping through walls the way a naively-parented mesh does.
 *
 * Motion is layered: sway follows the look delta, bob follows the gait, recoil is impulse
 * driven, and ADS blends the whole rig to a sight-aligned pose. Each layer is independent
 * so they compose rather than fight.
 */
import * as THREE from 'three';

/* ---------------------------------------------------------------- materials */

function gunMaterials() {
  return {
    steel: new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.42, metalness: 0.85 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.78, metalness: 0.05 }),
    fde: new THREE.MeshStandardMaterial({ color: 0x6d6250, roughness: 0.72, metalness: 0.06 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0e2a2e, roughness: 0.12, metalness: 0.4,
      transparent: true, opacity: 0.55 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.55, metalness: 0.35 }),
  };
}

/**
 * Part layouts per weapon class. Units are metres; the muzzle points down -Z.
 * `sightHeight` is where the optic axis sits, used to align the ADS pose.
 */
const LAYOUTS = {
  'Assault Rifle': {
    receiver: [0.055, 0.075, 0.34], receiverAt: [0, 0, -0.02],
    barrel: [0.017, 0.017, 0.30], barrelAt: [0, 0.016, -0.32],
    handguard: [0.048, 0.052, 0.22], handguardAt: [0, 0.012, -0.26],
    stock: [0.045, 0.065, 0.18], stockAt: [0, -0.004, 0.22],
    grip: [0.035, 0.095, 0.045], gripAt: [0, -0.078, 0.06], gripTilt: -0.28,
    mag: [0.032, 0.13, 0.075], magAt: [0, -0.095, -0.05], magTilt: 0.12,
    sightHeight: 0.058, rail: true,
  },
  SMG: {
    receiver: [0.050, 0.070, 0.26], receiverAt: [0, 0, -0.01],
    barrel: [0.015, 0.015, 0.16], barrelAt: [0, 0.014, -0.22],
    handguard: [0.044, 0.048, 0.14], handguardAt: [0, 0.010, -0.18],
    stock: [0.040, 0.055, 0.12], stockAt: [0, -0.002, 0.17],
    grip: [0.034, 0.090, 0.042], gripAt: [0, -0.074, 0.04], gripTilt: -0.30,
    mag: [0.030, 0.145, 0.062], magAt: [0, -0.100, -0.03], magTilt: 0.06,
    sightHeight: 0.054, rail: true,
  },
  Marksman: {
    receiver: [0.058, 0.080, 0.40], receiverAt: [0, 0, -0.02],
    barrel: [0.019, 0.019, 0.40], barrelAt: [0, 0.017, -0.40],
    handguard: [0.050, 0.054, 0.26], handguardAt: [0, 0.013, -0.30],
    stock: [0.048, 0.070, 0.22], stockAt: [0, -0.006, 0.25],
    grip: [0.036, 0.098, 0.046], gripAt: [0, -0.080, 0.08], gripTilt: -0.26,
    mag: [0.034, 0.115, 0.080], magAt: [0, -0.090, -0.04], magTilt: 0.10,
    sightHeight: 0.062, rail: true,
  },
  Shotgun: {
    receiver: [0.058, 0.082, 0.32], receiverAt: [0, 0, -0.02],
    barrel: [0.022, 0.022, 0.40], barrelAt: [0, 0.020, -0.38],
    handguard: [0.046, 0.046, 0.24], handguardAt: [0, -0.020, -0.30],
    stock: [0.048, 0.072, 0.22], stockAt: [0, -0.004, 0.22],
    grip: [0.038, 0.090, 0.048], gripAt: [0, -0.072, 0.06], gripTilt: -0.24,
    mag: null,
    sightHeight: 0.060, rail: false,
  },
  Sidearm: {
    receiver: [0.032, 0.060, 0.19], receiverAt: [0, 0, -0.02],
    barrel: [0.012, 0.012, 0.06], barrelAt: [0, 0.010, -0.14],
    handguard: null,
    stock: null,
    grip: [0.032, 0.105, 0.042], gripAt: [0, -0.072, 0.045], gripTilt: -0.32,
    mag: null,
    sightHeight: 0.038, rail: false,
  },
};

const box = (w, h, d, mat, pos, rotX = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  if (rotX) m.rotation.x = rotX;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
};

const cyl = (r, len, mat, pos, mats = 10) => {
  const g = new THREE.CylinderGeometry(r, r, len, mats);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  return m;
};

/** Builds a weapon mesh from its definition and attachment loadout. */
export function buildWeaponModel(weaponDef) {
  const L = LAYOUTS[weaponDef.class] ?? LAYOUTS['Assault Rifle'];
  const M = gunMaterials();
  const root = new THREE.Group();
  root.name = `wm_${weaponDef.id}`;

  const body = weaponDef.class === 'Sidearm' ? M.steel : M.polymer;

  root.add(box(...L.receiver, body, L.receiverAt));
  root.add(cyl(L.barrel[0], L.barrel[2], M.steel, L.barrelAt));
  if (L.handguard) root.add(box(...L.handguard, weaponDef.id === 'ar556' ? M.fde : body, L.handguardAt));
  if (L.stock) root.add(box(...L.stock, body, L.stockAt));
  root.add(box(...L.grip, M.polymer, L.gripAt, L.gripTilt));
  if (L.mag) root.add(box(...L.mag, M.polymer, L.magAt, L.magTilt));

  // Top rail — gives the optic something to sit on and reads as detail at ADS.
  if (L.rail) {
    for (let i = 0; i < 7; i++) {
      root.add(box(0.030, 0.006, 0.012, M.accent, [0, L.receiver[1] / 2 + 0.006, L.receiverAt[2] - 0.10 + i * 0.026]));
    }
  }

  // ---- attachments --------------------------------------------------------
  const a = weaponDef.attach ?? {};
  const sightGroup = new THREE.Group();
  const railY = L.receiver[1] / 2 + 0.012;

  if (a.sight === 'acog') {
    sightGroup.add(cyl(0.024, 0.115, M.accent, [0, railY + 0.026, -0.05]));
    sightGroup.add(cyl(0.026, 0.014, M.glass, [0, railY + 0.026, -0.108]));
    sightGroup.add(box(0.030, 0.026, 0.030, M.accent, [0, railY + 0.008, -0.05]));
    weaponDef._sightY = railY + 0.026;
  } else if (a.sight === 'holo') {
    sightGroup.add(box(0.042, 0.030, 0.070, M.accent, [0, railY + 0.016, -0.045]));
    sightGroup.add(box(0.034, 0.026, 0.004, M.glass, [0, railY + 0.020, -0.078]));
    weaponDef._sightY = railY + 0.020;
  } else if (a.sight === 'reflex') {
    sightGroup.add(box(0.030, 0.024, 0.040, M.accent, [0, railY + 0.012, -0.04]));
    sightGroup.add(box(0.026, 0.022, 0.003, M.glass, [0, railY + 0.018, -0.058]));
    weaponDef._sightY = railY + 0.018;
  } else {
    // Iron sights: a front post and a rear aperture.
    sightGroup.add(box(0.004, 0.018, 0.004, M.steel, [0, railY + 0.010, L.barrelAt[2] - L.barrel[2] * 0.32]));
    sightGroup.add(box(0.018, 0.014, 0.004, M.steel, [0, railY + 0.010, L.receiverAt[2] + 0.12]));
    weaponDef._sightY = railY + 0.010;
  }
  root.add(sightGroup);

  const muzzleZ = L.barrelAt[2] - L.barrel[2] / 2;
  if (a.barrel === 'suppressor') {
    root.add(cyl(0.024, 0.16, M.accent, [0, L.barrelAt[1], muzzleZ - 0.07]));
  } else if (a.barrel === 'compensator' || a.barrel === 'muzzle') {
    root.add(cyl(0.021, 0.05, M.steel, [0, L.barrelAt[1], muzzleZ - 0.022]));
  } else if (a.barrel === 'extended') {
    root.add(cyl(0.016, 0.10, M.steel, [0, L.barrelAt[1], muzzleZ - 0.05]));
  }

  if (a.grip === 'vertical') root.add(box(0.026, 0.075, 0.030, M.polymer, [0, L.handguardAt[1] - 0.058, L.handguardAt[2] - 0.02]));
  else if (a.grip === 'angled') root.add(box(0.026, 0.050, 0.055, M.polymer, [0, L.handguardAt[1] - 0.044, L.handguardAt[2] - 0.02], 0.5));

  if (a.under === 'laser') {
    root.add(box(0.020, 0.018, 0.040, M.accent, [0.028, L.handguardAt[1] - 0.012, L.handguardAt[2] - 0.04]));
  }

  // Muzzle reference for flash, tracers and the ballistic origin.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, L.barrelAt[1], muzzleZ - (a.barrel === 'suppressor' ? 0.15 : 0.02));
  muzzle.name = 'muzzle';
  root.add(muzzle);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { root, muzzle, sightY: weaponDef._sightY ?? 0.05, layout: L, materials: M };
}

/* ------------------------------------------------------------------- rig */

export class ViewModel {
  constructor(renderer, scene) {
    // A dedicated scene and camera: the viewmodel must never intersect world geometry or
    // be clipped by the world's near plane, and it wants a narrower FOV than the world so
    // the weapon does not look distorted at the edge of a wide player FOV.
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.008, 4);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Its own light rig so the weapon reads regardless of where the player is standing.
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-0.6, 1.0, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fa6c4, 0.7);
    fill.position.set(0.9, -0.2, -0.5);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x404a58, 1.1));

    this.current = null;
    // Hip carry sits well back from the near plane — a rifle is ~0.6 m long, and any
    // closer than this it fills half the screen at a 58 degree viewmodel FOV.
    this.hipPos = new THREE.Vector3(0.125, -0.130, -0.46);
    this.hipRot = new THREE.Euler(0.02, 0.10, 0.03);

    this.pos = this.hipPos.clone();
    this.rot = new THREE.Euler().copy(this.hipRot);
    this.swayVel = new THREE.Vector2();
    this.recoilPos = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.bobPhase = 0;
    this.reloadT = 0;
  }

  setWeapon(weaponDef) {
    if (this.current) this.root.remove(this.current.root);
    this.current = buildWeaponModel(weaponDef);
    this.root.add(this.current.root);
    this.def = weaponDef;
    return this.current;
  }

  /** Muzzle position/direction in world space, given the player's camera. */
  muzzleWorld(playerCamera, outPos, outDir) {
    // The viewmodel lives in its own space, so the world-space muzzle is derived from the
    // player camera rather than the viewmodel transform — otherwise every sway wobble
    // would throw the bullet off, which feels broken even though it looks "realistic".
    outPos.copy(playerCamera.position);
    outDir.set(0, 0, -1).applyQuaternion(playerCamera.quaternion);
    outPos.addScaledVector(outDir, 0.22);
    return outPos;
  }

  addRecoil(vertical, horizontal, kickBack = 0.028) {
    this.recoilPos.z += kickBack;
    this.recoilPos.y += vertical * 1.2;
    this.recoilRot.x -= vertical * 9.0;
    this.recoilRot.y += horizontal * 7.0;
    this.recoilRot.z += (Math.random() - 0.5) * 0.10;
  }

  update(dt, state) {
    if (!this.current) return;
    const { ads = 0, speed = 0, grounded = true, lookDX = 0, lookDY = 0,
            reloadProgress = 0, sprinting = false, lean = 0 } = state;

    // ---- sway: the weapon lags the view ------------------------------------
    const swayTarget = new THREE.Vector2(
      THREE.MathUtils.clamp(-lookDX * 0.9, -0.06, 0.06),
      THREE.MathUtils.clamp(-lookDY * 0.9, -0.05, 0.05),
    );
    this.swayVel.lerp(swayTarget, 1 - Math.exp(-12 * dt));

    // ---- bob ---------------------------------------------------------------
    if (grounded && speed > 0.3) this.bobPhase += dt * (5.4 + speed * 1.6);
    const bobScale = Math.min(1, speed / 3.4) * (1 - ads * 0.9);
    const bobX = Math.cos(this.bobPhase) * 0.011 * bobScale;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.014 * bobScale;

    // ---- ADS pose ----------------------------------------------------------
    // Aligning the sight with the camera axis means translating the gun so its optic sits
    // on the centre line, not just moving it "toward the middle".
    // ADS pulls the weapon back toward the eye and drops the optic onto the centre line.
    const adsPos = new THREE.Vector3(0, -this.current.sightY, -0.26);
    const target = new THREE.Vector3().copy(this.hipPos).lerp(adsPos, ads);
    const targetRot = new THREE.Euler(
      this.hipRot.x * (1 - ads),
      this.hipRot.y * (1 - ads),
      this.hipRot.z * (1 - ads) + lean * 0.06,
    );

    // ---- sprint pose: weapon lowered and angled across the body ------------
    if (sprinting) {
      target.x += 0.055; target.y -= 0.055; target.z += 0.05;
      targetRot.x += 0.32; targetRot.y += 0.42; targetRot.z -= 0.22;
    }

    // ---- reload: dip and rock ---------------------------------------------
    if (reloadProgress > 0) {
      const p = reloadProgress;
      // Down on the way in, back up on the way out.
      const dip = Math.sin(Math.min(1, p) * Math.PI);
      target.y -= dip * 0.075;
      target.z += dip * 0.03;
      targetRot.x += dip * 0.55;
      targetRot.z += dip * 0.22;
    }

    const k = 1 - Math.exp(-16 * dt);
    this.pos.lerp(target, k);
    this.rot.x += (targetRot.x - this.rot.x) * k;
    this.rot.y += (targetRot.y - this.rot.y) * k;
    this.rot.z += (targetRot.z - this.rot.z) * k;

    // ---- apply ------------------------------------------------------------
    this.root.position.copy(this.pos);
    this.root.position.x += this.swayVel.x + bobX;
    this.root.position.y += this.swayVel.y + bobY;
    this.root.position.add(this.recoilPos);

    this.root.rotation.set(
      this.rot.x + this.recoilRot.x * 0.02,
      this.rot.y + this.recoilRot.y * 0.02 + this.swayVel.x * 1.4,
      this.rot.z + this.recoilRot.z * 0.02,
    );

    // Recoil decays fast; the residual is what the player fights.
    const decay = Math.exp(-13 * dt);
    this.recoilPos.multiplyScalar(decay);
    this.recoilRot.multiplyScalar(decay);

    // FOV narrows with ADS, which is what actually sells magnification.
    const zoom = this.def?.zoom ?? 1.15;
    this.camera.fov = 58 / (1 + (zoom - 1) * ads * 0.55);
    this.camera.updateProjectionMatrix();
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Renders the viewmodel over the world, clearing depth so it never intersects it. */
  render(renderer) {
    if (!this.current) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
