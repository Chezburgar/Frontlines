/**
 * Training range.
 *
 * A no-pressure mode for testing weapons: every gun, optic and attachment is free and
 * swappable at any time, ammo is unlimited, and there are targets at marked distances with
 * live hit readout. It exists because the only way to try a scope used to be buying one
 * inside a 30-second prep phase and then surviving long enough to look through it.
 *
 * The range is built in the courtyard rather than as a separate map, so weapon feel is
 * being judged against the same lighting and surfaces the real match uses.
 */
import * as THREE from 'three';
import { WEAPONS, ATTACHMENTS } from './weapons.js';
import { audio } from '../core/audio.js';

/** Target distances in metres, laid out down the courtyard's long axis. */
const LANES = [5, 10, 15, 20, 30, 40];

const el = (tag, cls, parent, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};

export class TrainingRange {
  constructor(session) {
    this.s = session;
    this.group = new THREE.Group();
    this.group.name = 'range';
    session.scene.add(this.group);
    this.targets = [];
    this.stats = { shots: 0, hits: 0, headshots: 0, damage: 0 };
    this.lastHit = 0;
    this._v = new THREE.Vector3();
    this.build();
    this.buildUI();
  }

  /* ------------------------------------------------------------------ world */

  build() {
    const origin = new THREE.Vector3(0, 0.02, 12);   // south of the courtyard, firing north
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.5, metalness: 0.7 });
    const paint = new THREE.MeshStandardMaterial({ color: 0xc8552f, roughness: 0.8 });
    const post = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.75, metalness: 0.3 });

    for (let i = 0; i < LANES.length; i++) {
      const dist = LANES[i];
      // Fan the lanes slightly so distant targets are not hidden behind near ones.
      const x = (i - (LANES.length - 1) / 2) * 2.6;
      const z = origin.z - dist;

      const t = new THREE.Group();
      t.position.set(x, 0, z);

      // Stand.
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.08), post);
      leg.position.y = 0.45;
      t.add(leg);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.4), post);
      base.position.y = 0.03;
      t.add(base);

      // Torso plate with a head plate, so head/body hits are distinguishable.
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.62, 0.06), steel);
      body.position.y = 1.22;
      t.add(body);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.22, 0.06), paint);
      head.position.y = 1.64;
      t.add(head);

      t.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(t);

      // Distance label as a sprite so it always faces the shooter.
      const label = makeLabel(`${dist} m`);
      label.position.set(x, 2.05, z);
      this.group.add(label);

      this.targets.push({
        group: t, body, head, dist,
        centre: new THREE.Vector3(x, 1.22, z),
        headCentre: new THREE.Vector3(x, 1.64, z),
        down: false, downTimer: 0,
      });
    }

    // A firing line so the distances mean something.
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(18, 0.02, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xe8873a, roughness: 0.9 }),
    );
    line.position.copy(origin);
    this.group.add(line);
  }

  /* --------------------------------------------------------------------- UI */

  buildUI() {
    this.root = el('div', 'range-ui', document.getElementById('ui'));

    const head = el('div', 'range-head', this.root);
    el('h2', '', head, 'TRAINING RANGE');
    el('span', 'hint', head, 'Tab-free · unlimited ammo · every attachment unlocked');

    // ---- weapon picker ----------------------------------------------------
    const wrow = el('div', 'range-row', this.root);
    el('span', 'lbl', wrow, 'WEAPON');
    this.weaponSel = el('select', '', wrow);
    for (const [id, w] of Object.entries(WEAPONS)) {
      const o = el('option', '', this.weaponSel, `${w.name} — ${w.class}`);
      o.value = id;
    }
    this.weaponSel.value = 'ar556';
    this.weaponSel.onchange = () => this.rebuildAttachments();

    this.attachWrap = el('div', 'range-attach', this.root);

    // ---- readout ----------------------------------------------------------
    const stats = el('div', 'range-stats', this.root);
    this.shotsNode = el('div', 'st', stats);
    this.accNode = el('div', 'st', stats);
    this.hsNode = el('div', 'st', stats);
    this.dmgNode = el('div', 'st', stats);

    const btns = el('div', 'range-row', this.root);
    const reset = el('button', 'cbtn', btns, 'RESET STATS');
    reset.onclick = () => { this.stats = { shots: 0, hits: 0, headshots: 0, damage: 0 }; };
    const back = el('button', 'cbtn', btns, 'LEAVE RANGE');
    back.onclick = () => this.s.app.leaveRange?.();
    el('span', 'hint', btns, 'Right-click to aim · targets reset automatically');

    this.rebuildAttachments();
  }

  rebuildAttachments() {
    const id = this.weaponSel.value;
    const w = WEAPONS[id];
    this.attachWrap.innerHTML = '';
    this.choice = { sight: 'none', barrel: 'none', grip: 'none', under: 'none' };

    for (const [cat, options] of Object.entries(w.attachments ?? {})) {
      const row = el('label', 'range-row', this.attachWrap);
      el('span', 'lbl', row, cat.toUpperCase());
      const sel = el('select', '', row);
      for (const optId of options) {
        const o = el('option', '', sel, ATTACHMENTS[cat][optId].name);
        o.value = optId;
      }
      // Default to the strongest optic available so scopes are the first thing you see.
      if (cat === 'sight') {
        const best = options[options.length - 1];
        sel.value = best;
        this.choice.sight = best;
      }
      sel.onchange = () => { this.choice[cat] = sel.value; this.equip(); };
    }
    this.equip();
  }

  equip() {
    const id = this.weaponSel.value;
    this.s.equip(this.s.local, {
      primary: { id, attach: { ...this.choice } },
      secondary: { id: 'p9', attach: { sight: 'none', barrel: 'none', grip: 'none', under: 'none' } },
    });
    audio.ui('confirm');
  }

  /* ------------------------------------------------------------------- tick */

  update(dt) {
    // Unlimited ammo — the range is for feel, not for magazine management.
    const w = this.s.weapon;
    if (w) { w.reserve = 999; if (w.ammo <= 0 && w.reloading <= 0) w.startReload(); }

    for (const t of this.targets) {
      if (!t.down) continue;
      t.downTimer -= dt;
      // Fold the plate away while down, then pop it back up.
      const k = Math.max(0, Math.min(1, t.downTimer / 0.35));
      t.group.rotation.x = -1.3 * k;
      if (t.downTimer <= 0) { t.down = false; t.group.rotation.x = 0; }
    }
    this.updateStats();
  }

  updateStats() {
    const s = this.stats;
    const acc = s.shots ? (s.hits / s.shots * 100) : 0;
    this.shotsNode.textContent = `SHOTS ${s.shots}`;
    this.accNode.textContent = `ACCURACY ${acc.toFixed(0)}%`;
    this.hsNode.textContent = `HEADSHOTS ${s.headshots}`;
    this.dmgNode.textContent = `DAMAGE ${Math.round(s.damage)}`;
  }

  /**
   * Tests a shot against the range targets.
   * Returns true if a target was hit, so the caller can skip normal player resolution.
   */
  testShot(origin, dir) {
    this.stats.shots++;
    let best = null;
    for (const t of this.targets) {
      if (t.down) continue;
      const h = rayBox(origin, dir, t.headCentre, 0.10, 0.11, 0.06);
      const b = rayBox(origin, dir, t.centre, 0.225, 0.31, 0.06);
      const d = h ?? b;
      if (d == null) continue;
      if (!best || d < best.d) best = { t, d, head: h != null && (b == null || h <= b) };
    }
    if (!best) return false;

    this.stats.hits++;
    if (best.head) this.stats.headshots++;
    const w = this.s.weapon?.def;
    const dmg = w ? damageAt(w, best.d) * (best.head ? w.headMult : 1) : 0;
    this.stats.damage += dmg;

    const point = origin.clone().addScaledVector(dir, best.d);
    this.s.impacts.add(point, dir.clone().negate(), { decal: 0x2a2724 });
    this.s.particles.emit(point, 8, {
      color: best.head ? 0xffb457 : 0xbfc6cf, speed: 4, life: 0.4, size: 0.03,
    });
    audio.impact({ position: point, surface: 'metal' });
    this.s.hitFeedback = { t: 0.22, kill: false, head: best.head };

    best.t.down = true;
    best.t.downTimer = 1.1;
    this.showHit(best.t.dist, Math.round(dmg), best.head);
    return true;
  }

  showHit(dist, dmg, head) {
    if (!this.hitNode) this.hitNode = el('div', 'range-hit', document.getElementById('ui'));
    this.hitNode.textContent = `${dist} m · ${dmg}${head ? ' HEADSHOT' : ''}`;
    this.hitNode.classList.toggle('head', head);
    this.hitNode.classList.add('show');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => this.hitNode.classList.remove('show'), 900);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.root?.remove();
    this.hitNode?.remove();
  }
}

/* ------------------------------------------------------------------ helpers */

function damageAt(w, metres) {
  const bands = w.damage;
  if (metres <= bands[0][0]) return bands[0][1] * (w.damageScale ?? 1);
  for (let i = 1; i < bands.length; i++) {
    if (metres <= bands[i][0]) {
      const [r0, d0] = bands[i - 1], [r1, d1] = bands[i];
      return (d0 + (d1 - d0) * ((metres - r0) / (r1 - r0))) * (w.damageScale ?? 1);
    }
  }
  return bands[bands.length - 1][1] * (w.damageScale ?? 1);
}

/** Ray against an axis-aligned box, returning the entry distance or null. */
function rayBox(o, d, centre, hx, hy, hz) {
  let tmin = 0, tmax = 200;
  const lo = [centre.x - hx, centre.y - hy, centre.z - hz];
  const hi = [centre.x + hx, centre.y + hy, centre.z + hz];
  const ro = [o.x, o.y, o.z], rd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) < 1e-8) {
      if (ro[i] < lo[i] || ro[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - ro[i]) / rd[i];
      let t2 = (hi[i] - ro[i]) / rd[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,12,17,0.75)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.font = '600 40px Rajdhani, sans-serif';
  ctx.fillStyle = '#ffb457';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.2, 0.3, 1);
  return sprite;
}
