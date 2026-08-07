/**
 * Frontlines spectator / broadcast client.
 *
 * A separate deployment from the game, gated on the `spectator` flag an admin grants.
 * It joins a live match as an extra peer that never sends input — the host treats it as a
 * viewer, so a spectator can never influence the round.
 *
 * Camera modes:
 *   FREE      fly anywhere, no collision
 *   FOLLOW    third person behind a chosen player
 *   EYES      that player's own view
 *
 * Everything a caster needs to clean up the frame — scoreboard, killfeed, nameplates,
 * the HUD itself — toggles independently, and recording writes locally via MediaRecorder
 * so nothing is uploaded anywhere.
 */
import * as THREE from 'three';
import { FrontlineRenderer, QUALITY } from '../src/core/renderer.js';
import { GameMap } from '../src/world/map.js';
import { buildLighting } from '../src/world/lighting.js';
import { createOperator, OperatorAnimator } from '../src/game/character.js';
import * as Net from '../src/net/supabase.js';
import { Transport } from '../src/net/transport.js';
import { readSnapshot, SnapshotBuffer } from '../src/net/sync.js';
import { SpectatorUI } from './ui.js';
import './ui.css';

const el = {
  canvas: document.getElementById('view'),
  ui: document.getElementById('ui'),
  fatal: document.getElementById('fatal'),
  fatalmsg: document.getElementById('fatalmsg'),
};

const BENIGN = [/pointer lock/i, /not allowed by the user agent/i, /AudioContext/i];
const isBenign = (e) => BENIGN.some((r) => r.test((e && (e.message || e.name)) || String(e ?? '')));
function fatal(err) {
  if (isBenign(err)) { console.warn('[recovered]', err?.message); return; }
  console.error(err);
  el.fatal.style.display = 'block';
  el.fatalmsg.textContent = (err && (err.stack || err.message)) || String(err);
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => { if (!isBenign(e.reason)) fatal(e.reason); });

export const MODE = { FREE: 'free', FOLLOW: 'follow', EYES: 'eyes' };

class Spectator {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
    this.clock = new THREE.Clock();
    this.quality = localStorage.getItem('fl.quality') || 'high';
    this.renderer = new FrontlineRenderer(el.canvas, this.quality);
    this.map = new GameMap();

    this.mode = MODE.FREE;
    this.targetId = null;
    this.players = new Map();          // netIndex -> { rig, anim, state }
    this.snapshots = new SnapshotBuffer();
    this.match = { round: 0, score: [0, 0], phase: '', timeLeft: 0 };

    // Free cam state.
    this.pos = new THREE.Vector3(0, 12, 30);
    this.yaw = Math.PI; this.pitch = -0.3;
    this.vel = new THREE.Vector3();
    this.speed = 8;
    this.keys = new Set();
    this.locked = false;

    this.recorder = null;
    this.recChunks = [];
    this.recording = false;

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._bindInput();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.resetHistory();
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.setMode(MODE.FREE);
      if (e.code === 'Digit2') this.setMode(MODE.FOLLOW);
      if (e.code === 'Digit3') this.setMode(MODE.EYES);
      if (e.code === 'BracketRight') this.cycleTarget(1);
      if (e.code === 'BracketLeft') this.cycleTarget(-1);
      if (e.code === 'KeyR' && e.ctrlKey) { e.preventDefault(); this.toggleRecording(); }
      if (e.code === 'KeyH') this.ui?.toggleAll();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    el.canvas.addEventListener('click', () => { if (!this.locked) el.canvas.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el.canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.mode !== MODE.FREE) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.54, 1.54);
    });
    el.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.15 : 0.87), 0.5, 60);
    }, { passive: false });
  }

  /* ------------------------------------------------------------------ boot */

  async load(onProgress) {
    await this.map.build(onProgress);
    this.scene.add(this.map.root);
    this.lighting = buildLighting(this.scene, this.renderer.renderer, 'afternoon', QUALITY[this.quality]);
    this.lighting.interior.buildFromPoints(this.map.lights);
    this.renderer.renderer.compile(this.scene, this.camera);
  }

  start() {
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.applySnapshot();
    this.updateCamera(dt);
    this.updateBodies(dt);

    this.lighting.sun.update(this.camera);
    this.lighting.interior.update(this.camera.position);
    this.renderer.markShadowsDirty();
    this.renderer.applyJitter(this.camera);
    this.renderer.render(this.scene, this.camera, dt);
    this.ui?.update(this);
  }

  /* ---------------------------------------------------------------- camera */

  setMode(mode) {
    if (mode !== MODE.FREE && !this.targetId) this.cycleTarget(1);
    this.mode = mode;
    this.renderer.resetHistory();
    this.ui?.flash(`CAMERA — ${mode.toUpperCase()}`);
  }

  cycleTarget(dir) {
    const ids = [...this.players.keys()];
    if (!ids.length) return;
    const i = ids.indexOf(this.targetId);
    this.targetId = ids[((i + dir) % ids.length + ids.length) % ids.length];
    this.renderer.resetHistory();
  }

  get target() { return this.players.get(this.targetId); }

  updateCamera(dt) {
    const t = this.target;
    if (this.mode === MODE.EYES && t) {
      // Sit in the player's head. Slightly behind the eye so the body does not clip.
      this.camera.position.set(t.state.x, t.state.y + 1.63, t.state.z);
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotateY(t.state.yaw);
      this.camera.rotateX(t.state.pitch);
      this.camera.fov = 75;
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.mode === MODE.FOLLOW && t) {
      // Trail behind and above, easing so the shot stays watchable.
      const want = new THREE.Vector3(
        t.state.x + Math.sin(t.state.yaw) * 3.2,
        t.state.y + 2.35,
        t.state.z + Math.cos(t.state.yaw) * 3.2,
      );
      this.pos.lerp(want, 1 - Math.exp(-6 * dt));
      this.camera.position.copy(this.pos);
      this.camera.lookAt(t.state.x, t.state.y + 1.5, t.state.z);
      this.camera.fov = 62;
      this.camera.updateProjectionMatrix();
      return;
    }

    // Free cam — no collision, deliberately.
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (this.keys.has('KeyW')) wish.add(fwd);
    if (this.keys.has('KeyS')) wish.sub(fwd);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);
    if (this.keys.has('Space')) wish.y += 1;
    if (this.keys.has('ControlLeft')) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();
    const spd = this.speed * (this.keys.has('ShiftLeft') ? 3 : 1);
    this.vel.lerp(wish.multiplyScalar(spd), 1 - Math.exp(-10 * dt));
    this.pos.addScaledVector(this.vel, dt);

    this.camera.position.copy(this.pos);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------- replication */

  applySnapshot() {
    const snap = this.snapshots.sample();
    if (!snap) return;
    this.match.round = snap.round;
    this.match.score = snap.score;
    this.match.timeLeft = snap.timeLeft;
    this.match.phase = { p: 'PREP', a: 'ACTION', o: 'OVER', e: 'ROUND OVER', w: 'WARMUP' }[snap.phaseChar] ?? '';

    for (const ps of snap.players) {
      let p = this.players.get(ps.netIndex);
      if (!p) {
        const rig = createOperator({ team: ps.netIndex % 2 ? 'defend' : 'attack' });
        this.scene.add(rig.group);
        p = { rig, anim: new OperatorAnimator(rig), state: ps, name: this.roster?.[ps.netIndex] ?? `P${ps.netIndex}` };
        this.players.set(ps.netIndex, p);
      }
      p.prev = p.state;
      p.state = ps;
    }
    if (!this.targetId && this.players.size) this.cycleTarget(1);
  }

  updateBodies(dt) {
    for (const [id, p] of this.players) {
      const s = p.state;
      p.rig.group.visible = s.alive || s.dbno;
      // In eyes mode the body you are inside must not be drawn.
      if (this.mode === MODE.EYES && id === this.targetId) p.rig.group.visible = false;
      if (!p.rig.group.visible) continue;
      p.rig.group.position.set(s.x, s.y, s.z);
      p.rig.group.rotation.y = s.yaw;
      const speed = p.prev ? Math.hypot(s.x - p.prev.x, s.z - p.prev.z) * 20 : 0;
      p.anim.update(dt, {
        speed, grounded: true, crouch: s.stance === 1 ? 1 : s.stance === 2 ? 1.35 : 0,
        lean: 0, pitch: s.pitch, aim: s.aiming ? 1 : 0,
      });
    }
  }

  /* ------------------------------------------------------------------ join */

  async join(lobbyId, userId) {
    this.signal = Net.openSignal(lobbyId, userId);
    this.transport = new Transport({
      selfId: userId, isHost: false, signal: this.signal,
      handlers: {
        onState: (_from, buf) => {
          const snap = readSnapshot(buf);
          if (snap) this.snapshots.push(snap);
        },
        onEvent: (_from, msg) => {
          if (msg.t === 'welcome') {
            this.roster = Object.fromEntries((msg.roster ?? []).map((r) => [r.i, r.name]));
          } else if (msg.t === 'event') {
            this.ui?.onMatchEvent(msg.name, msg.data);
          }
        },
        onPeerLeave: () => this.ui?.flash('HOST DISCONNECTED'),
      },
    });
    this.transport.announce();
    // Announce presence so the host can render the spectator camera prop in-world.
    this.signal.send('*', { t: 'spectator', id: userId });
    this.connected = true;
  }

  /* -------------------------------------------------------------- recording */

  toggleRecording() { this.recording ? this.stopRecording() : this.startRecording(); }

  /**
   * Records the canvas locally. Nothing is uploaded — the blob is handed straight to a
   * download, so footage never leaves the machine.
   */
  startRecording() {
    if (this.recording) return;
    const stream = el.canvas.captureStream(60);
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    this.recChunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.recorder.onstop = () => {
      const blob = new Blob(this.recChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `frontlines-${stamp}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.ui?.flash('RECORDING SAVED');
    };
    this.recorder.start(1000);
    this.recording = true;
    this.recStart = performance.now();
    this.ui?.flash('RECORDING');
  }

  stopRecording() {
    if (!this.recording) return;
    this.recorder.stop();
    this.recording = false;
  }
}

/* ============================================================== bootstrap */

async function boot() {
  const app = new Spectator();
  window.__SPEC = app;
  const ui = new SpectatorUI(el.ui, app);
  app.ui = ui;

  ui.showLoading('Generating Teahouse');
  await app.load((p, label) => ui.showLoading(label ?? 'Loading', p));
  app.start();

  // ---- access control ----------------------------------------------------
  const user = await Net.currentUser().catch(() => null);
  if (!user) return ui.showGate('Sign in with an approved account to spectate.', true);

  let profile = null;
  try { profile = await Net.getProfile(user.id); }
  catch { return ui.showGate('Could not load your profile.', true); }

  const allowed = profile.spectator || profile.role === 'admin' || profile.role === 'moderator';
  if (!allowed) {
    return ui.showGate(
      `${profile.username}, this account does not have spectator access. `
      + 'An administrator has to grant it.', false);
  }

  app.user = user;
  app.profile = profile;
  ui.showBrowser();
}

boot().catch(fatal);

export { Spectator };
