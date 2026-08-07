/**
 * Weapons: definitions, attachments, ballistics and recoil.
 *
 * Damage is range-banded rather than a single number, and every round carries a
 * penetration budget in centimetres of "concrete equivalent" that is spent as it passes
 * through surfaces. That makes shooting through a shoji screen nearly free, through a
 * plaster partition costly, and through a stone foundation impossible — using the same
 * numbers the destruction system uses, so what you can shoot through and what you can
 * break stay consistent.
 *
 * Recoil is a deterministic per-shot pattern plus a small random spread, so a pattern can
 * be learned and pulled down the way it can in Siege, while still not being pixel-perfect.
 */

export const SLOT = { PRIMARY: 0, SECONDARY: 1 };

/* --------------------------------------------------------------- attachments */

/**
 * Optics.
 *
 * `reticle` selects how the sight picture is drawn, and `scoped` marks the magnified
 * optics that get a full scope overlay with a black surround — the thing that makes a
 * 2.5x actually feel different from a red dot rather than just being a zoom number.
 */
export const ATTACHMENTS = {
  sight: {
    none: { name: 'Iron Sights', adsTime: 1.0, zoom: 1.10, cone: 1.0, reticle: 'iron' },
    reflex: { name: 'Reflex', adsTime: 1.02, zoom: 1.18, cone: 0.97, reticle: 'dot' },
    holo: { name: 'Holographic', adsTime: 1.06, zoom: 1.25, cone: 0.95, reticle: 'holo' },
    acog: { name: '2.5x Scope', adsTime: 1.24, zoom: 2.5, cone: 0.88, sway: 1.35, reticle: 'chevron', scoped: true },
    scope4: { name: '4x Scope', adsTime: 1.36, zoom: 4.0, cone: 0.82, sway: 1.7, reticle: 'mildot', scoped: true },
    scope12: { name: '12x Scope', adsTime: 1.62, zoom: 9.0, cone: 0.7, sway: 2.4, reticle: 'sniper', scoped: true },
  },
  barrel: {
    none: { name: 'None' },
    suppressor: { name: 'Suppressor', loudness: 0.38, damage: 0.92, recoil: 0.94, flash: 0.25 },
    compensator: { name: 'Compensator', recoilH: 0.72, loudness: 1.05 },
    muzzle: { name: 'Muzzle Brake', recoilV: 0.78, loudness: 1.08 },
    extended: { name: 'Extended Barrel', damage: 1.12, adsTime: 1.06 },
  },
  grip: {
    none: { name: 'None' },
    vertical: { name: 'Vertical Grip', recoilV: 0.86, adsTime: 0.96 },
    angled: { name: 'Angled Grip', adsTime: 0.85, recoilH: 0.95 },
  },
  under: {
    none: { name: 'None' },
    laser: { name: 'Laser', hipCone: 0.72, visible: true },
  },
};

/* ------------------------------------------------------------- definitions */

/**
 * `damage` bands are [metres, damage] pairs, interpolated between.
 * `recoilPattern` is per-shot [vertical, horizontal] in radians before modifiers.
 * `penetration` is the round's budget in cm of concrete-equivalent.
 */
export const WEAPONS = {
  // ---- assault rifles -----------------------------------------------------
  ar556: {
    id: 'ar556', name: 'AR-556', class: 'Assault Rifle', slot: SLOT.PRIMARY,
    rpm: 690, mag: 30, reserve: 150, reload: 2.4, reloadEmpty: 3.1,
    damage: [[0, 38], [22, 34], [40, 27]], headMult: 2.35, limbMult: 0.85,
    penetration: 11, muzzleVelocity: 880,
    adsTime: 0.26, hipCone: 0.042, adsCone: 0.0022, moveCone: 0.055,
    recoilPattern: buildPattern(0.0092, 0.0031, 31),
    recoverRate: 7.2, loudness: 1.0, weight: 1.0,
    attachments: { sight: ['none', 'reflex', 'holo', 'acog'], barrel: ['none', 'suppressor', 'compensator', 'muzzle', 'extended'], grip: ['none', 'vertical', 'angled'], under: ['none', 'laser'] },
  },
  k1a: {
    id: 'k1a', name: 'K1A', class: 'Assault Rifle', slot: SLOT.PRIMARY,
    rpm: 720, mag: 30, reserve: 150, reload: 2.3, reloadEmpty: 3.0,
    damage: [[0, 33], [22, 30], [40, 24]], headMult: 2.4, limbMult: 0.85,
    penetration: 9, muzzleVelocity: 840,
    adsTime: 0.23, hipCone: 0.040, adsCone: 0.0024, moveCone: 0.052,
    recoilPattern: buildPattern(0.0079, 0.0038, 31),
    recoverRate: 8.0, loudness: 0.95, weight: 0.94,
    attachments: { sight: ['none', 'reflex', 'holo', 'acog'], barrel: ['none', 'suppressor', 'compensator', 'muzzle', 'extended'], grip: ['none', 'vertical', 'angled'], under: ['none', 'laser'] },
  },
  // ---- submachine guns ----------------------------------------------------
  mp5k: {
    id: 'mp5k', name: 'MP5K', class: 'SMG', slot: SLOT.PRIMARY,
    rpm: 800, mag: 30, reserve: 150, reload: 2.1, reloadEmpty: 2.8,
    damage: [[0, 28], [18, 25], [34, 19]], headMult: 2.3, limbMult: 0.88,
    penetration: 6, muzzleVelocity: 400,
    adsTime: 0.20, hipCone: 0.034, adsCone: 0.0026, moveCone: 0.044,
    recoilPattern: buildPattern(0.0062, 0.0029, 31),
    recoverRate: 9.4, loudness: 0.86, weight: 0.86,
    attachments: { sight: ['none', 'reflex', 'holo'], barrel: ['none', 'suppressor', 'compensator', 'extended'], grip: ['none', 'vertical', 'angled'], under: ['none', 'laser'] },
  },
  // ---- marksman -----------------------------------------------------------
  dmr417: {
    id: 'dmr417', name: 'DMR-417', class: 'Marksman', slot: SLOT.PRIMARY,
    rpm: 300, mag: 20, reserve: 100, reload: 2.6, reloadEmpty: 3.3, semiAuto: true,
    damage: [[0, 62], [30, 58], [55, 50]], headMult: 2.1, limbMult: 0.9,
    penetration: 22, muzzleVelocity: 980,
    adsTime: 0.34, hipCone: 0.070, adsCone: 0.0012, moveCone: 0.09,
    recoilPattern: buildPattern(0.0210, 0.0044, 21),
    recoverRate: 5.4, loudness: 1.25, weight: 1.14,
    attachments: { sight: ['none', 'reflex', 'holo', 'acog', 'scope4', 'scope12'], barrel: ['none', 'suppressor', 'compensator', 'muzzle', 'extended'], grip: ['none', 'vertical', 'angled'], under: ['none', 'laser'] },
  },
  // ---- shotgun ------------------------------------------------------------
  m870: {
    id: 'm870', name: 'M870', class: 'Shotgun', slot: SLOT.PRIMARY,
    rpm: 85, mag: 7, reserve: 40, reload: 0.62, reloadEmpty: 0.62, shellByShell: true,
    pellets: 9, damage: [[0, 22], [8, 15], [18, 6]], headMult: 1.6, limbMult: 0.95,
    penetration: 3, muzzleVelocity: 380,
    adsTime: 0.28, hipCone: 0.085, adsCone: 0.048, moveCone: 0.10,
    recoilPattern: buildPattern(0.0340, 0.0070, 9),
    recoverRate: 4.2, loudness: 1.35, weight: 1.1,
    // Buckshot chews soft cover: the map's primary hole-maker for shoji and plaster.
    breachPower: 3.2,
    attachments: { sight: ['none', 'reflex', 'holo'], barrel: ['none'], grip: ['none', 'vertical'], under: ['none', 'laser'] },
  },
  // ---- sidearms -----------------------------------------------------------
  p9: {
    id: 'p9', name: 'P9', class: 'Sidearm', slot: SLOT.SECONDARY,
    rpm: 450, mag: 15, reserve: 60, reload: 1.8, reloadEmpty: 2.4, semiAuto: true,
    damage: [[0, 26], [15, 22], [30, 16]], headMult: 2.4, limbMult: 0.9,
    penetration: 4, muzzleVelocity: 360,
    adsTime: 0.17, hipCone: 0.038, adsCone: 0.0030, moveCone: 0.05,
    recoilPattern: buildPattern(0.0125, 0.0035, 15),
    recoverRate: 10.5, loudness: 0.8, weight: 0.7,
    attachments: { sight: ['none', 'reflex'], barrel: ['none', 'suppressor'], grip: ['none'], under: ['none', 'laser'] },
  },
  rev357: {
    id: 'rev357', name: 'Model 357', class: 'Sidearm', slot: SLOT.SECONDARY,
    rpm: 300, mag: 6, reserve: 36, reload: 2.6, reloadEmpty: 2.6, semiAuto: true,
    damage: [[0, 54], [15, 48], [30, 38]], headMult: 2.2, limbMult: 0.9,
    penetration: 14, muzzleVelocity: 440,
    adsTime: 0.20, hipCone: 0.044, adsCone: 0.0026, moveCone: 0.06,
    recoilPattern: buildPattern(0.0290, 0.0060, 6),
    recoverRate: 6.5, loudness: 1.2, weight: 0.78,
    attachments: { sight: ['none', 'reflex'], barrel: ['none'], grip: ['none'], under: ['none', 'laser'] },
  },
};

/**
 * Recoil patterns.
 *
 * The first few shots climb hard and nearly straight, then the muzzle starts wandering
 * horizontally in a repeatable S — that shape is what makes a pattern learnable. Generated
 * from a seeded curve rather than hand-authored so every weapon is internally consistent.
 */
function buildPattern(vBase, hBase, shots) {
  const out = [];
  for (let i = 0; i < shots; i++) {
    const t = i / Math.max(1, shots - 1);
    // Vertical: steep for the first third, then flattening as the weapon settles.
    const v = vBase * (1.35 - 0.75 * Math.pow(t, 0.65));
    // Horizontal: no drift for the first 3 shots, then a smooth alternating sweep.
    const ramp = Math.max(0, (i - 2) / shots);
    const h = hBase * Math.sin(i * 0.72) * ramp * 2.4;
    out.push([v, h]);
  }
  return out;
}

/* ---------------------------------------------------------------- resolving */

/** Folds attachment modifiers into a flat stat block. */
export function resolveWeapon(weaponId, loadout = {}) {
  const base = WEAPONS[weaponId];
  if (!base) throw new Error(`unknown weapon ${weaponId}`);

  const picked = {
    sight: ATTACHMENTS.sight[loadout.sight] ?? ATTACHMENTS.sight.none,
    barrel: ATTACHMENTS.barrel[loadout.barrel] ?? ATTACHMENTS.barrel.none,
    grip: ATTACHMENTS.grip[loadout.grip] ?? ATTACHMENTS.grip.none,
    under: ATTACHMENTS.under[loadout.under] ?? ATTACHMENTS.under.none,
  };

  const mul = (key, dflt = 1) =>
    Object.values(picked).reduce((acc, a) => acc * (a[key] ?? 1), dflt);

  return {
    ...base,
    attach: loadout,
    picked,
    zoom: picked.sight.zoom ?? 1.12,
    adsTime: base.adsTime * mul('adsTime'),
    damageScale: mul('damage'),
    recoilV: mul('recoil') * mul('recoilV'),
    recoilH: mul('recoil') * mul('recoilH'),
    hipCone: base.hipCone * mul('hipCone'),
    adsCone: base.adsCone * mul('cone'),
    loudness: base.loudness * mul('loudness'),
    swayScale: mul('sway'),
    hasLaser: !!picked.under.visible,
    flash: picked.barrel.flash ?? 1,
    fireInterval: 60 / base.rpm,
  };
}

/** Damage at a given range, interpolating the bands. */
export function damageAtRange(weapon, metres) {
  const bands = weapon.damage;
  if (metres <= bands[0][0]) return bands[0][1] * weapon.damageScale;
  for (let i = 1; i < bands.length; i++) {
    if (metres <= bands[i][0]) {
      const [r0, d0] = bands[i - 1], [r1, d1] = bands[i];
      const t = (metres - r0) / (r1 - r0);
      return (d0 + (d1 - d0) * t) * weapon.damageScale;
    }
  }
  return bands[bands.length - 1][1] * weapon.damageScale;
}

/* ------------------------------------------------------------ runtime state */

/** Live firing state for one equipped weapon. */
export class WeaponInstance {
  constructor(weaponId, loadout) {
    this.def = resolveWeapon(weaponId, loadout);
    this.ammo = this.def.mag;
    this.reserve = this.def.reserve;
    this.shotIndex = 0;
    this.cooldown = 0;
    this.reloading = 0;
    this.reloadTotal = 0;
    this.pendingShell = false;
    this.lastFired = -999;
    this.heat = 0;              // drives the recoil pattern index decay
  }

  get empty() { return this.ammo <= 0; }
  get canReload() { return this.reserve > 0 && this.ammo < this.def.mag && !this.reloading; }

  /** Current cone of fire, in radians. */
  cone(adsBlend, speed, grounded) {
    const d = this.def;
    const base = d.hipCone + (d.adsCone - d.hipCone) * adsBlend;
    const move = Math.min(1, speed / 3.4) * d.moveCone * (1 - adsBlend * 0.7);
    const air = grounded ? 0 : d.moveCone * 1.4;
    // Sustained fire opens the cone; this is the "spray penalty".
    const bloom = Math.min(1, this.heat / 12) * d.hipCone * 0.5 * (1 - adsBlend * 0.85);
    return base + move + air + bloom;
  }

  /** Returns the recoil kick for the current shot index. */
  recoil() {
    const p = this.def.recoilPattern;
    const step = p[Math.min(this.shotIndex, p.length - 1)];
    return [step[0] * this.def.recoilV, step[1] * this.def.recoilH];
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this._finishReload();
    }
    // Recoil pattern walks back down when not firing.
    const idle = performance.now() / 1000 - this.lastFired;
    if (idle > 0.22) {
      this.shotIndex = Math.max(0, this.shotIndex - this.def.recoverRate * dt);
      this.heat = Math.max(0, this.heat - dt * 6);
    }
  }

  tryFire(now, triggerHeld, triggerPressed) {
    if (this.reloading > 0 || this.cooldown > 0 || this.empty) return false;
    if (this.def.semiAuto && !triggerPressed) return false;
    if (!this.def.semiAuto && !triggerHeld) return false;
    this.ammo--;
    this.cooldown = this.def.fireInterval;
    this.shotIndex = Math.min(this.def.recoilPattern.length - 1, Math.floor(this.shotIndex) + 1);
    this.heat = Math.min(20, this.heat + 1);
    this.lastFired = now;
    return true;
  }

  startReload() {
    if (!this.canReload) return false;
    const d = this.def;
    if (d.shellByShell) {
      this.reloading = d.reload;
      this.reloadTotal = d.reload;
      this.pendingShell = true;
    } else {
      this.reloading = this.empty ? d.reloadEmpty : d.reload;
      this.reloadTotal = this.reloading;
    }
    return true;
  }

  cancelReload() {
    // Shell-by-shell reloads keep what they already loaded; magazine reloads are lost.
    this.reloading = 0;
    this.pendingShell = false;
  }

  _finishReload() {
    const d = this.def;
    if (d.shellByShell) {
      const room = d.mag - this.ammo;
      if (room > 0 && this.reserve > 0) { this.ammo++; this.reserve--; }
      if (this.ammo < d.mag && this.reserve > 0) {
        this.reloading = d.reload;      // chain the next shell
        this.reloadTotal = d.reload;
        return;
      }
      this.pendingShell = false;
    } else {
      const need = d.mag - this.ammo;
      const take = Math.min(need, this.reserve);
      this.ammo += take;
      this.reserve -= take;
    }
    this.shotIndex = 0;
    this.heat = 0;
  }
}
