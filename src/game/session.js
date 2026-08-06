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

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._lastLook = new THREE.Vector2();
  }

  /* ------------------------------------------------------------------ setup */

  /** Registers the local player and a set of bots so the loop is exercisable solo. */
  setup({ localName = 'OPERATOR', botCount = 9 } = {}) {
    const local = this.addPlayer({
      id: 'local', name: localName, team: 0, slot: 0, local: true,
      controller: this.app.player,
    });
    this.local = local;

    for (let i = 0; i < botCount; i++) {
      const team = i < 4 ? 0 : 1;
      this.addPlayer({
        id: `bot${i}`, name: `BOT-${String(i + 1).padStart(2, '0')}`,
        team, slot: (i % 5) + (team === 0 ? 1 : 0), bot: true,
      });
    }

    this.equip(local, DEFAULT_LOADOUT);
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
    if (player.local) this.viewmodel.setWeapon(player.weapons[0].def);
  }

  get weapon() { return this.local?.weapons?.[this.local.slot]; }

  /* ------------------------------------------------------------------- tick */

  update(dt, cmd) {
    const p = this.local;
    const ctrl = this.app.player;
    p.position.copy(ctrl.position);
    p.stance = ctrl.stance;
    p.ads = ctrl.ads;

    this.match.update(dt);

    const w = this.weapon;
    if (w) w.update(dt);

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

    if (cmd.weaponSlot >= 0 && cmd.weaponSlot < this.local.weapons.length && cmd.weaponSlot !== this.local.slot) {
      this.local.slot = cmd.weaponSlot;
      w.cancelReload();
      this.viewmodel.setWeapon(this.weapon.def);
      return;
    }
    if (cmd.cycleWeapon) {
      this.local.slot = (this.local.slot + (cmd.cycleWeapon > 0 ? 1 : -1) + this.local.weapons.length) % this.local.weapons.length;
      w.cancelReload();
      this.viewmodel.setWeapon(this.weapon.def);
      return;
    }
    if (cmd.reload) w.startReload();
    // Firing interrupts a shell-by-shell reload, which is what makes the shotgun a
    // real commitment rather than a free top-up.
    if ((cmd.fire || cmd.firePressed) && w.reloading > 0 && w.def.shellByShell && w.ammo > 0) w.cancelReload();

    if (ctrl.sprinting) return;

    const now = performance.now() / 1000;
    if (w.tryFire(now, cmd.fire, cmd.firePressed)) this.fire(w);
  }

  fire(w) {
    const ctrl = this.app.player;
    const cam = this.app.camera;
    const origin = this._tmpA.copy(cam.position);
    const forward = this._tmpB.set(0, 0, -1).applyQuaternion(cam.quaternion);

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
      weapon: w,
      coneDegrees: cone * (180 / Math.PI),
      prompt: this.prompt,
      hit: this.hitFeedback,
    });
    this.hud.renderScoreboard(this.match, this.players.values(), cmd.scoreboard);
  }

  /* ----------------------------------------------------------------- events */

  onMatchEvent(ev) {
    switch (ev.type) {
      case 'player:killed':
        this.hud.addKill({
          attackerName: ev.attackerName, targetName: ev.targetName,
          headshot: ev.headshot,
          attackerTeam: this.match.sideOf[this.players.get(ev.attacker)?.team ?? 0],
        });
        break;
      case 'round:start':
        this.hud.showBanner(`ROUND ${this.match.round}`,
          this.match.site ? this.match.site.name.toUpperCase() : '');
        this.impacts.clear();
        break;
      case 'phase:action':
        this.hud.showBanner('ACTION PHASE', '', 1800);
        break;
      case 'bomb:planted':
        this.hud.showBanner('CHARGE PLANTED', '', 2200);
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
