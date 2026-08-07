/**
 * Match session: binds input, combat, the round state machine and the HUD together.
 *
 * This is the layer the netcode will slot under — every mutation of shared state goes
 * through `match`, and every local prediction goes through `controller`, so a host
 * authority can later replace the local resolution without the rest of the game noticing.
 */
import * as THREE from 'three';
import { WeaponInstance, WEAPONS } from './weapons.js';
import { fireRound, damageSurface, reinforcePiece, ImpactSystem, ParticleSystem } from './combat.js';
import { Match, PHASE, TEAM, WIN } from './match.js';
import { ViewModel } from './viewmodel.js';
import { createOperator, OperatorAnimator } from './character.js';
import { HUD } from '../ui/hud.js';
import { STANCE } from './controller.js';
import { BotBrain } from './bots.js';
import { audio } from '../core/audio.js';
import { surfaceOf } from '../world/materials.js';
import { applySkin } from '../ui/banner.js';
import { GadgetSystem, GADGETS, SIDE, buildGadgetModel } from './gadgets.js';
import { BuyMenu } from '../ui/buymenu.js';
import { Drone } from './drone.js';

const DEFAULT_LOADOUT = {
  primary: { id: 'ar556', attach: { sight: 'holo', barrel: 'compensator', grip: 'vertical', under: 'none' } },
  secondary: { id: 'p9', attach: { sight: 'none', barrel: 'none', grip: 'none', under: 'none' } },
};

export class Session {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.map = app.map;
    this.players = new Map();
    this.destroyedThisTick = false;

    this.impacts = new ImpactSystem(this.scene, 640);
    this.particles = new ParticleSystem(this.scene, 1100);

    this.viewmodel = new ViewModel(app.renderer.renderer, this.scene);
    this.viewmodel.resize(app.camera.aspect);

    this.hud = new HUD(document.getElementById('ui'));
    this.hitFeedback = { t: 0, kill: false, head: false };

    this.match = new Match(this, {});
    this.match.on((ev) => this.onMatchEvent(ev));

    this.gadgets = new GadgetSystem(this);
    this.buy = new BuyMenu(document.getElementById('ui'), this);
    this.flashAmount = 0;

    this.net = null;          // NetBridge, when online
    this.voice = null;        // VoiceChat, when online
    this.botsEnabled = true;
    this.tick = 0;

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._lastLook = new THREE.Vector2();
  }

  /* ------------------------------------------------------------------ setup */

  /** Registers the local player and a set of bots so the loop is exercisable solo. */
  setup({ localName = 'OPERATOR', botCount = 9, loadout = null, skins = {}, banner = null } = {}) {
    this.skins = skins;
    const local = this.addPlayer({
      id: 'local', name: localName, team: 0, slot: 0, local: true, banner,
      controller: this.app.player,
    });
    this.local = local;

    this.bots = [];
    for (let i = 0; i < botCount; i++) {
      const team = i < 4 ? 0 : 1;
      const p = this.addPlayer({
        id: `bot${i}`, name: `BOT-${String(i + 1).padStart(2, '0')}`,
        team, slot: (i % 5) + (team === 0 ? 1 : 0), bot: true,
        yaw: 0, pitch: 0, speed: 0,
      });
      this.bots.push(new BotBrain(this, p));
    }

    this.equip(local, loadout ?? DEFAULT_LOADOUT);
    this.match.startMatch();
    return this;
  }

  addPlayer(spec) {
    const p = {
      alive: true, health: 100, dbno: false, dbnoTime: 0,
      kills: 0, deaths: 0, damageDealt: 0, hasBomb: false,
      height: 1.78, radius: 0.32,
      position: new THREE.Vector3(),
      ...spec,
    };
    // Every non-local player gets a visible body.
    if (!p.local) {
      p.rig = createOperator({ team: this.match?.sideOf?.[p.team] === TEAM.DEFEND ? 'defend' : 'attack' });
      p.anim = new OperatorAnimator(p.rig);
      p.rig.group.visible = false;
      this.scene.add(p.rig.group);
    }
    this.players.set(p.id, p);
    return p;
  }

  equip(player, loadout) {
    player.loadout = loadout;
    player.weapons = [
      new WeaponInstance(loadout.primary.id, loadout.primary.attach),
      new WeaponInstance(loadout.secondary.id, loadout.secondary.attach),
    ];
    player.slot = 0;
    if (player.local) {
      const built = this.viewmodel.setWeapon(player.weapons[0].def);
      applySkin(built.materials, this.skins?.[loadout.primary.id] ?? 'default');
    }
  }

  get weapon() { return this.local?.weapons?.[this.local.slot]; }

  /** Rebuilds the viewmodel for the currently held weapon, with its skin applied. */
  _equipViewmodel() {
    const w = this.weapon;
    if (!w) return;
    const built = this.viewmodel.setWeapon(w.def);
    applySkin(built.materials, this.skins?.[w.def.id] ?? 'default');
  }

  /* ------------------------------------------------------------------- tick */

  update(dt, cmd) {
    const p = this.local;
    const ctrl = this.app.player;
    p.position.copy(ctrl.position);
    p.stance = ctrl.stance;
    p.ads = ctrl.ads;

    this.tick++;
    // Only the host advances the round state machine; clients take it from snapshots.
    if (!this.net || this.net.isHost) this.match.update(dt);

    const w = this.weapon;
    if (w) w.update(dt);

    // Prep-only state has to be torn down here, before any early return below can skip
    // it. If preparation ended while the buy menu was open, input stayed disabled and the
    // spawn barrier kept pushing — which read in-game as simply being unable to move or
    // shoot once the round started.
    if (this.match.phase !== PHASE.PREP) {
      if (this.buy.open) this.buy.close();
      this.app.player.prepBarrier = null;
      this.app.input.enabled = true;
    }

    // While the buy menu is open the player is frozen.
    if (cmd.menu && this.buy.open) this.buy.close();
    else if (this.buy.open) { this.updateHUD(cmd); return; }
    if (cmd.buyMenu && this.match.phase === PHASE.PREP) this.buy.toggle();

    if (cmd.drone) this.toggleDrone();
    if (this.drone) {
      this.drone.update(dt, cmd, this.driving);
      if (!this.drone.alive) this.exitDrone();
    }
    if (cmd.ping) this.dropPing();
    this.handleGadgets(dt, cmd);
    this.updatePrepBarrier();

    if (this.match.phase === PHASE.ACTION || this.match.phase === PHASE.PLANTED
        || this.match.phase === PHASE.PREP) {
      this.handleWeapon(dt, cmd, w);
      this.handleInteract(dt, cmd);
    }

    // Viewmodel motion wants the raw look delta, not the smoothed camera.
    this.viewmodel.update(dt, {
      ads: ctrl.ads,
      speed: ctrl.speed,
      grounded: ctrl.grounded,
      lookDX: cmd.lookX,
      lookDY: cmd.lookY,
      sprinting: ctrl.sprinting,
      lean: ctrl.lean,
      reloadProgress: w && w.reloading > 0 ? 1 - w.reloading / Math.max(0.001, w.reloadTotal) : 0,
    });

    // Bots exist only on the host (or offline) — a client would otherwise simulate its
    // own divergent copy of every one of them.
    if (this.botsEnabled) for (const b of this.bots ?? []) { if (!b.retired) b.update(dt); }

    if (this.net) {
      if (this.net.isHost) this.net.hostTick(dt);
      else this.net.clientTick(dt, cmd);
    }
    if (this.voice) this.voice.update(dt, this.players, cmd.voice);

    audio.updateListener(this.app.camera);
    this.updateFootsteps(dt);
    this.updateBombAudio(dt);

    this.gadgets.update(dt);
    this.buy.tick();

    // Flashbang whiteout decays; the renderer's grade drives the actual screen effect.
    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * 0.55);
      this.app.renderer.grade.flash = this.flashAmount * 0.9;
      this.hud.setFlash(this.flashAmount);
    } else if (this.app.renderer.grade.flash) {
      this.app.renderer.grade.flash = 0;
      this.hud.setFlash(0);
    }

    this.particles.update(dt);
    this.hitFeedback.t = Math.max(0, this.hitFeedback.t - dt);

    // Destruction changes the collision mesh, so the BVH is rebuilt at most once a tick.
    if (this.destroyedThisTick) {
      this.map.rebuildCollision();
      this.destroyedThisTick = false;
    }

    this.updateBodies(dt);
    this.updateHUD(cmd);
  }

  handleWeapon(dt, cmd, w) {
    if (!w) return;
    const ctrl = this.app.player;

    if (cmd.weaponSlot >= 0 && this.local.holdingGadget) { this.stowGadget(); if (cmd.weaponSlot === this.local.slot) return; }
    if (cmd.weaponSlot >= 0 && cmd.weaponSlot < this.local.weapons.length && cmd.weaponSlot !== this.local.slot) {
      this.local.slot = cmd.weaponSlot;
      w.cancelReload();
      this._equipViewmodel();
      return;
    }
    if (cmd.cycleWeapon) {
      this.local.slot = (this.local.slot + (cmd.cycleWeapon > 0 ? 1 : -1) + this.local.weapons.length) % this.local.weapons.length;
      w.cancelReload();
      this._equipViewmodel();
      return;
    }
    if (cmd.reload && w.startReload()) {
      audio.reload({ empty: w.empty, shell: !!w.def.shellByShell });
    }
    // Firing interrupts a shell-by-shell reload, which is what makes the shotgun a
    // real commitment rather than a free top-up.
    if ((cmd.fire || cmd.firePressed) && w.reloading > 0 && w.def.shellByShell && w.ammo > 0) w.cancelReload();

    if (ctrl.sprinting) return;
    // The fire button throws the equipped gadget instead of firing the weapon.
    if (this.local.holdingGadget) return;

    const now = performance.now() / 1000;
    if (w.tryFire(now, cmd.fire, cmd.firePressed)) this.fire(w);
  }

  fire(w) {
    const ctrl = this.app.player;
    const cam = this.app.camera;
    const origin = this._tmpA.copy(cam.position);
    const forward = this._tmpB.set(0, 0, -1).applyQuaternion(cam.quaternion);

    // As a client, the host owns damage: report the ray and let it re-trace. Local
    // feedback (recoil, flash, sound) still fires immediately so shooting feels instant.
    if (this.net && !this.net.isHost) {
      this.net.reportShot(origin, forward);
      const [rv0, rh0] = w.recoil();
      this.app.player.addRecoil(rv0, rh0 * (Math.random() < 0.5 ? -1 : 1));
      this.viewmodel.addRecoil(rv0, rh0);
      this.flash(w);
      audio.gunshot({ weapon: w.def, firstPerson: true, suppressed: w.def.attach?.barrel === 'suppressor' });
      return;
    }

    const cone = w.cone(ctrl.ads, ctrl.speed, ctrl.grounded);
    const pellets = w.def.pellets ?? 1;
    let anyHit = false, anyKill = false, anyHead = false;

    for (let i = 0; i < pellets; i++) {
      const dir = forward.clone();
      if (cone > 0) {
        // Uniform disc in the cone, not a gaussian: keeps the spread bounded so a
        // crosshair that shows the cone is telling the truth.
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * cone;
        const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
        const up = new THREE.Vector3().crossVectors(right, dir).normalize();
        dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      }

      const result = fireRound(this, origin, dir, w.def, this.local);
      for (const h of result.hits) {
        if (h.kind === 'surface') {
          this.impacts.add(h.point, h.normal, h.surface);
          this.particles.emit(h.point, 5, {
            color: h.surface.debris, speed: 2.6, life: 0.5, size: 0.022,
          });
          // Only the first pellet of a shotgun blast gets an impact sound; nine of them
          // firing at once is mud, not detail.
          if (i === 0) audio.impact({ position: h.point, surface: h.surfaceName });
          const piece = h.piece;
          if (piece) {
            const power = (w.def.breachPower ?? 1) * 34;
            damageSurface(this, piece, h.point, power);
          }
        } else if (h.kind === 'player') {
          anyHit = true;
          if (h.zone === 'head') anyHead = true;
          this.particles.emit(h.point, 6, { color: 0x8c1f18, speed: 2.2, life: 0.45, size: 0.026 });
          const outcome = this.match.applyDamage(h.target, h.damage, this.local, h.zone);
          if (outcome === 'kill') anyKill = true;
        }
      }
    }

    if (anyHit) this.hitFeedback = { t: 0.22, kill: anyKill, head: anyHead };

    audio.gunshot({
      weapon: w.def, firstPerson: true,
      suppressed: w.def.attach?.barrel === 'suppressor',
    });

    // Recoil: the view kicks, the model kicks harder and recovers faster.
    const [rv, rh] = w.recoil();
    this.app.player.addRecoil(rv, rh * (Math.random() < 0.5 ? -1 : 1));
    this.viewmodel.addRecoil(rv, rh);

    // Muzzle flash as a short-lived light plus sparks.
    this.flash(w);
  }

  flash(w) {
    if (!this._flashLight) {
      this._flashLight = new THREE.PointLight(0xffd9a0, 0, 9, 2);
      this.scene.add(this._flashLight);
    }
    const cam = this.app.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const at = cam.position.clone().addScaledVector(dir, 0.5);
    this._flashLight.position.copy(at);
    this._flashLight.intensity = 14 * (w.def.flash ?? 1);
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { if (this._flashLight) this._flashLight.intensity = 0; }, 34);
    this.particles.emit(at, 3, { color: 0xffbb66, speed: 5, life: 0.09, size: 0.05 });
  }

  /**
   * Footsteps for the local player and every bot.
   *
   * Driven by distance travelled rather than a timer, so stride length stays constant and
   * a walking player is genuinely quieter than a sprinting one — which is the whole
   * information economy of the genre.
   */
  updateFootsteps(dt) {
    const stride = 2.05;
    const step = (entity, pos, speed, running) => {
      if (speed < 0.35) { entity._stepDist = 0; return; }
      entity._stepDist = (entity._stepDist ?? 0) + speed * dt;
      if (entity._stepDist < stride * (running ? 0.78 : 1)) return;
      entity._stepDist = 0;
      // Sample the floor under the foot to pick the surface.
      const down = this.map.raycast(
        new THREE.Vector3(pos.x, pos.y + 0.6, pos.z), DOWN_V, 1.6);
      const surf = down ? surfaceOf(down.surfaceName).footstep : 'stone';
      const isLocal = entity === this.local;
      audio.footstep({
        position: isLocal ? null : pos,
        surface: surf,
        running,
        occlusion: isLocal ? 0 : audio.occlusionTo(this.map, pos),
        gain: isLocal ? 0.4 : 1,
      });
    };

    const ctrl = this.app.player;
    if (ctrl.grounded) {
      step(this.local, ctrl.position, ctrl.speed, ctrl.sprinting);
    }
    for (const b of this.bots ?? []) {
      if (b.p.alive) step(b.p, b.p.position, b.p.speed ?? 0, (b.p.speed ?? 0) > 2.2);
    }
  }

  /** Once the charge is live it beeps, faster as the fuse runs down. */
  updateBombAudio(dt) {
    const m = this.match;
    if (m.phase !== 'planted' || !m.bomb.position) { this._beepIn = 0; return; }
    const frac = 1 - m.timeLeft / m.rules.fuseSeconds;
    const interval = 1.15 - frac * 0.85;
    this._beepIn = (this._beepIn ?? 0) - dt;
    if (this._beepIn <= 0) {
      this._beepIn = interval;
      audio.bombBeep({ position: m.bomb.position, urgency: frac });
    }
  }

  /* ---------------------------------------------------------------- gadgets */

  /**
   * Gadget selection and use.
   *
   * Selecting a gadget actually equips it: the viewmodel swaps to the grenade and the fire
   * button throws or places it. The previous scheme left the rifle on screen and bound
   * throwing to a separate key, which gave no indication a gadget was equipped at all.
   */
  handleGadgets(dt, cmd) {
    const local = this.local;
    if (!local.gadgets?.length) return;

    // 3 / 4 equip a gadget; 1 / 2 (handled in handleWeapon) put it away.
    if (cmd.gadgetSlot >= 0 && cmd.gadgetSlot < local.gadgets.length) {
      if (local.holdingGadget && local.gadgetSlot === cmd.gadgetSlot) {
        this.stowGadget();
      } else {
        local.gadgetSlot = cmd.gadgetSlot;
        this.equipGadget();
      }
      return;
    }
    if (!local.holdingGadget) return;

    const g = local.gadgets[local.gadgetSlot ?? 0];
    if (!g || g.count <= 0) { this.stowGadget(); return; }

    const cam = this.app.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);

    if (g.def.kind === 'throw') {
      // Hold to cook, release to throw. Holding also shows the cook time on the HUD.
      if (cmd.fire) {
        this._cook = (this._cook ?? 0) + dt;
        this.cookTime = this._cook;
        // A cooked frag that runs out detonates in your hand, as it should.
        if (g.def.fuse > 0 && this._cook > g.def.fuse) {
          this.gadgets.throwGrenade(g.id, local, cam.position.clone(), dir, 0.05)
            .fuse = 0.01;
          g.count--; this._cook = 0; this.cookTime = 0;
          this.afterGadgetUse(g);
        }
      } else if (this._cook > 0) {
        const power = Math.min(1, 0.5 + this._cook * 0.6);
        const thrown = this.gadgets.throwGrenade(
          g.id, local, cam.position.clone().addScaledVector(dir, 0.45), dir, power);
        // Cooking eats into the fuse — that is the whole point of holding it.
        if (thrown && g.def.fuse > 0) thrown.fuse = Math.max(0.25, g.def.fuse - this._cook);
        this._cook = 0; this.cookTime = 0;
        g.count--;
        audio.ui('tick');
        this.afterGadgetUse(g);
      }
    } else if (g.def.kind === 'place' && cmd.firePressed) {
      const hit = this.map.raycast(cam.position, dir, 2.8);
      if (!hit) { this.hud.showBanner('NOTHING TO PLACE ON', '', 1000); audio.ui('deny'); return; }
      if (g.id === 'breach' && !hit.piece?.reinforceable) {
        this.hud.showBanner('CANNOT BREACH THIS SURFACE', '', 1200);
        audio.ui('deny');
        return;
      }
      this.gadgets.place(g.id, local, hit);
      g.count--;
      this.afterGadgetUse(g);
    }
  }

  /**
   * Holds each team in its own area during preparation.
   *
   * Attackers stay outside the estate wall, defenders stay inside the building envelope.
   * Both are released the instant the action phase starts.
   */
  updatePrepBarrier() {
    const ctrl = this.app.player;
    if (this.match.phase !== PHASE.PREP) {
      ctrl.prepBarrier = null;
      if (this._barrierWarned) this._barrierWarned = false;
      return;
    }
    const attacking = this.match.sideOf[this.local.team] === TEAM.ATTACK;
    // Both barriers are the building envelope (18 x 15): attackers stay out of the house,
    // defenders stay in it. Holding attackers outside the *estate wall* was wrong — their
    // spawns sit at z = 24.5, inside that box, so the barrier fought them from the first
    // frame and snapped them to its edge every single tick.
    ctrl.prepBarrier = attacking
      ? { x: 19.4, z: 16.4, keepOutside: true }
      : { x: 19.0, z: 16.0, keepOutside: false };

    if (ctrl.blockedByBarrier && !this._barrierWarned) {
      this._barrierWarned = true;
      this.hud.showBanner(attacking ? 'HOLD UNTIL THE ACTION PHASE' : 'STAY INSIDE THE BUILDING',
        'Preparation', 1600);
      audio.ui('deny');
      setTimeout(() => { this._barrierWarned = false; }, 2600);
    }
  }

  /* ------------------------------------------------------------------ drone */

  /**
   * Deploys or re-enters the drone. Driving swaps which camera renders, so the player's
   * body stays exactly where it was left and remains vulnerable throughout.
   */
  toggleDrone() {
    if (this.match.sideOf[this.local.team] !== TEAM.ATTACK) {
      this.hud.showBanner('DRONES ARE ATTACKER EQUIPMENT', '', 1200);
      audio.ui('deny');
      return;
    }
    if (this.driving) { this.exitDrone(); return; }

    if (!this.drone || !this.drone.alive) {
      const ctrl = this.app.player;
      const fwd = new THREE.Vector3(-Math.sin(ctrl.yaw), 0, -Math.cos(ctrl.yaw));
      const at = ctrl.position.clone().addScaledVector(fwd, 1.1);
      at.y += 0.4;
      this.drone = new Drone(this, this.local, at);
    }
    this.driving = true;
    this.local.driving = true;
    this.stowGadget();
    this.hud.showBanner('DRONE', 'T to exit', 1200);
    audio.ui('confirm');
  }

  exitDrone() {
    if (!this.driving) return;
    this.driving = false;
    this.local.driving = false;
    audio.ui('tick');
  }

  /** Which camera the frame should be rendered from. */
  get activeCamera() {
    return this.driving && this.drone?.alive ? this.drone.camera : this.app.camera;
  }

  equipGadget() {
    const g = this.local.gadgets[this.local.gadgetSlot ?? 0];
    if (!g || g.count <= 0) { audio.ui('deny'); return; }
    this.local.holdingGadget = true;
    this.viewmodel.setGadget(buildGadgetModel(g.id), g.def);
    audio.ui('tick');
  }

  stowGadget() {
    if (!this.local.holdingGadget) return;
    this.local.holdingGadget = false;
    this._cook = 0;
    this.cookTime = 0;
    this._equipViewmodel();
  }

  /** Out of a gadget: go back to the weapon rather than holding nothing. */
  afterGadgetUse(g) {
    if (g.count <= 0) this.stowGadget();
  }

  /**
   * A standing marker on the objective.
   *
   * Carrying the charge with no idea where it goes is the single most disorienting thing
   * about a first round, so the site is marked permanently for whoever holds it — and for
   * defenders, so they know what they are protecting. It refreshes rather than piling up.
   */
  updateObjectiveMarker() {
    const m = this.match;
    const site = m.site;
    if (!site || m.phase === PHASE.ENDED || m.phase === PHASE.MATCH_OVER) return;

    const show = m.phase === PHASE.PLANTED
      ? true
      : (this.local.hasBomb || m.sideOf[this.local.team] === TEAM.DEFEND);
    if (!show) { this._objPing = null; return; }

    const now = performance.now() / 1000;
    if (this._objPing && now - this._objPing.born < 4) return;

    // Once planted, mark the charge itself; before that, mark the site centre.
    let point;
    let label;
    if (m.bomb.planted && m.bomb.position) {
      point = m.bomb.position.clone().add(new THREE.Vector3(0, 0.5, 0));
      label = 'CHARGE';
    } else {
      const room = this.map.rooms.find((r) => r.id === site.rooms[0]);
      if (!room) return;
      point = new THREE.Vector3(
        (room.rect[0] + room.rect[2]) / 2, room.y + 1.2, (room.rect[1] + room.rect[3]) / 2);
      label = m.sideOf[this.local.team] === TEAM.DEFEND ? `DEFEND — ${room.name.toUpperCase()}`
        : `PLANT — ${room.name.toUpperCase()}`;
    }
    this._objPing = this.hud.addPing({ position: point, kind: 'objective', name: label });
  }

  /** Adds trauma to the camera shake. Explosions call this scaled by distance. */
  addShake(amount) {
    this.app.player.shake = Math.min(1.2, (this.app.player.shake ?? 0) + amount);
  }

  /** Flashbang whiteout for the local player. */
  applyFlash(amount) {
    this.flashAmount = Math.max(this.flashAmount, Math.min(1.6, amount));
  }

  /* ------------------------------------------------------------------ pings */

  /**
   * Marks whatever the player is looking at for the whole team.
   * The ping is placed on the surface rather than at a fixed distance, so "that corner"
   * and "that doorway" land where they were meant to.
   */
  dropPing() {
    const cam = this.app.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const hit = this.map.raycast(cam.position, dir, 90);
    const point = hit ? hit.point.clone().addScaledVector(hit.normal, 0.15)
      : cam.position.clone().addScaledVector(dir, 25);

    // An enemy under the crosshair pings as a contact instead of a location.
    let kind = 'mark';
    let name = '';
    for (const p of this.players.values()) {
      if (!p.alive || p.team === this.local.team || p.local) continue;
      const to = new THREE.Vector3(p.position.x, p.position.y + 1.2, p.position.z);
      if (to.distanceTo(point) < 2.2) { kind = 'enemy'; name = 'CONTACT'; break; }
    }
    const room = this.map.roomAt(point);
    if (kind === 'mark' && room) name = room.name.toUpperCase();

    this.hud.addPing({ position: point, kind, name, team: this.local.team });
    audio.ui('confirm');
    this.net?.transport?.broadcastEvent({
      t: 'ping', p: point.toArray().map((v) => +v.toFixed(2)), kind, name,
    });
  }

  /** Muzzle flash for a shot fired somewhere other than the local camera (bots). */
  flashAt(pos, dir, weaponDef) {
    this.particles.emit(pos.clone().addScaledVector(dir, 0.4), 3,
      { color: 0xffbb66, speed: 4, life: 0.08, size: 0.045 });
    audio.gunshot({
      position: pos, weapon: weaponDef,
      occlusion: audio.occlusionTo(this.map, pos),
      suppressed: weaponDef?.attach?.barrel === 'suppressor',
    });
  }

  handleInteract(dt, cmd) {
    const p = this.local;
    const ctrl = this.app.player;
    const m = this.match;
    this.prompt = '';

    // Reinforcing during prep.
    if (m.phase === PHASE.PREP && m.sideOf[p.team] === TEAM.DEFEND) {
      const hit = this.map.raycast(this.app.camera.position,
        new THREE.Vector3(0, 0, -1).applyQuaternion(this.app.camera.quaternion), 3.0);
      if (hit?.piece?.reinforceable && !hit.piece.reinforced) {
        this.prompt = '[F] REINFORCE';
        if (cmd.interact) reinforcePiece(hit.piece);
      }
    }

    // Plant / defuse.
    if (m.phase === PHASE.ACTION && p.hasBomb && m.inSite(ctrl.position)) {
      this.prompt = cmd.interactHeld ? '' : '[HOLD F] PLANT CHARGE';
      m.tryPlant(p, dt, cmd.interactHeld);
    } else if (m.phase === PHASE.PLANTED && m.sideOf[p.team] === TEAM.DEFEND) {
      const near = m.bomb.position && ctrl.position.distanceTo(m.bomb.position) < 1.6;
      if (near) this.prompt = cmd.interactHeld ? '' : '[HOLD F] DEFUSE';
      m.tryDefuse(p, dt, cmd.interactHeld);
    } else if (m.phase === PHASE.ACTION && p.hasBomb) {
      this.prompt = `CARRY THE CHARGE TO ${m.site?.name?.toUpperCase() ?? 'THE SITE'}`;
    }
  }

  /** Places and animates the third-person bodies of non-local players. */
  updateBodies(dt) {
    for (const p of this.players.values()) {
      if (p.local || !p.rig) continue;
      const show = p.alive || p.dbno;
      p.rig.group.visible = show;
      if (!show) continue;
      p.rig.group.position.copy(p.position);
      p.rig.group.rotation.y = p.yaw ?? 0;
      p.anim.update(dt, {
        speed: p.speed ?? 0, grounded: true,
        crouch: p.dbno ? 1.35 : 0, lean: 0, pitch: p.pitch ?? 0, aim: p.aiming ? 1 : 0,
      });
    }
  }

  updateHUD(cmd) {
    const w = this.weapon;
    const ctrl = this.app.player;
    const cone = w ? w.cone(ctrl.ads, ctrl.speed, ctrl.grounded) : 0.02;
    this.hud.update({
      match: this.match,
      player: { health: this.local.health, dbno: this.local.dbno, stance: ctrl.stance, ads: ctrl.ads },
      weapon: this.local.holdingGadget ? null : w,
      gadgetHeld: this.local.holdingGadget ? this.local.gadgets[this.local.gadgetSlot ?? 0] : null,
      cookTime: this.cookTime ?? 0,
      coneDegrees: cone * (180 / Math.PI),
      prompt: this.prompt,
      hit: this.hitFeedback,
    });
    this.hud.renderScoreboard(this.match, this.players.values(), cmd.scoreboard);
    this.hud.setGadgets(
      (this.local.gadgets ?? []).map((g) => ({ name: g.def.name, count: g.count })),
      this.local.gadgetSlot ?? 0);
    this.hud.setScope(w?.def?.picked?.sight, this.app.player.ads);
    this.updateObjectiveMarker();
    this.hud.updatePings(this.app.camera, performance.now() / 1000);
  }

  /* ----------------------------------------------------------------- events */

  onMatchEvent(ev) {
    // The host is the only authority on round events, so it mirrors them to everyone.
    this.net?.mirrorEvent?.(ev.type, {
      targetName: ev.targetName, attackerName: ev.attackerName,
      headshot: ev.headshot, winner: ev.winner, reason: ev.reason, score: ev.score,
    });
    switch (ev.type) {
      case 'player:killed':
        this.hud.addKill({
          attackerName: ev.attackerName, targetName: ev.targetName,
          headshot: ev.headshot,
          attackerTeam: this.match.sideOf[this.players.get(ev.attacker)?.team ?? 0],
        });
        break;
      case 'bomb:planted':
        // Spawn the physical charge so it can actually be found and defused.
        this.gadgets.plantBomb(this.match.bomb.position);
        break;
      case 'round:start':
        this.gadgets.clear();
        this.buy.resetForRound();
        this.hud.showBanner(`ROUND ${this.match.round}`,
          this.match.site ? this.match.site.name.toUpperCase() : '');
        this.impacts.clear();
        break;
      case 'phase:action':
        this.hud.showBanner('ACTION PHASE', '', 1800);
        break;
      case 'round:end': {
        const localSide = this.match.sideOf[this.local.team];
        const won = ev.winner === localSide;
        const why = { [WIN.ELIMINATION]: 'ENEMY TEAM ELIMINATED', [WIN.DETONATION]: 'CHARGE DETONATED',
                      [WIN.DEFUSE]: 'CHARGE DEFUSED', [WIN.TIME]: 'TIME EXPIRED' }[ev.reason] ?? '';
        this.hud.showBanner(won ? 'ROUND WON' : 'ROUND LOST', why, 4200);
        break;
      }
      case 'match:end':
        this.hud.showBanner(
          ev.winner === this.match.sideOf[this.local.team] ? 'VICTORY' : 'DEFEAT',
          `${ev.score[TEAM.ATTACK]} — ${ev.score[TEAM.DEFEND]}`, 9000);
        break;
      default: break;
    }
  }

  render(renderer) { this.viewmodel.render(renderer); }

  resize(aspect) { this.viewmodel.resize(aspect); }
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN_V = new THREE.Vector3(0, -1, 0);
