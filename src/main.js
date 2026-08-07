/**
 * Frontlines entry point.
 *
 * Boot order matters: the title card plays immediately on a 2D canvas while the map (12 MB)
 * downloads in parallel, so the download is hidden behind the intro rather than stacked
 * after it. WebGL is only created once the intro is on screen.
 */
import * as THREE from 'three';
import { FrontlineRenderer, QUALITY } from './core/renderer.js';
import { GameMap } from './world/map.js';
import { buildLighting } from './world/lighting.js';
import { playIntro } from './ui/intro.js';
import { Input } from './core/input.js';
import { PlayerController } from './game/controller.js';
import { createOperator, OperatorAnimator } from './game/character.js';
import { Session } from './game/session.js';
import { Shell } from './ui/shell.js';
import './ui/hud.css';
import './ui/shell.css';

const BASE = import.meta.env.BASE_URL || '/';

const el = {
  canvas: document.getElementById('view'),
  boot: document.getElementById('boot'),
  bootCanvas: document.getElementById('bootcanvas'),
  loader: document.getElementById('loader'),
  loadbar: document.getElementById('loadbar'),
  loadstatus: document.getElementById('loadstatus'),
  loadtip: document.getElementById('loadtip'),
  fatal: document.getElementById('fatal'),
  fatalmsg: document.getElementById('fatalmsg'),
  ui: document.getElementById('ui'),
};

const TIPS = [
  'Lean with <b>Q</b> and <b>E</b> to clear an angle without exposing your body.',
  'Drones and cameras are shared intel — call what you see, not where you are.',
  'A wall you can shoot through is a wall they can shoot back through.',
  'Rappel outside a window and hold — the defuser has to walk past you eventually.',
  'Sound carries through floors. Walking is slower; it is also quieter.',
  'Reinforce the walls that matter, not every wall you can reach.',
  'The bomb timer beats the round timer. Plant early, hold the angle.',
];

function fatal(err) {
  console.error(err);
  el.fatal.style.display = 'block';
  el.fatalmsg.textContent = (err && (err.stack || err.message)) || String(err);
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

function setProgress(p, status) {
  el.loadbar.style.width = `${Math.round(p * 100)}%`;
  if (status) el.loadstatus.textContent = status;
}

/* ============================================================ application */

class App {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 400);
    this.clock = new THREE.Clock();
    this.quality = localStorage.getItem('fl.quality') || 'high';
    this.renderer = new FrontlineRenderer(el.canvas, this.quality);
    this.map = new GameMap();
    this.running = false;
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.resetHistory();
    this.session?.resize(w / h);
  }

  async load() {
    setProgress(0.02, 'Connecting');

    await this.map.build((p, label) => setProgress(0.02 + p * 0.72, label));
    this.scene.add(this.map.root);
    console.info(`[map] ${this.map.triangleCount.toLocaleString()} collision tris, ` +
      `${this.map.pieces.length} destructible pieces, ${this.map.rooms.length} rooms`);

    setProgress(0.78, 'Building light rig');
    this.lighting = buildLighting(this.scene, this.renderer.renderer, 'afternoon', QUALITY[this.quality]);
    const lampCount = this.lighting.interior.buildFromPoints(this.map.lights);
    console.info(`[lighting] ${lampCount} interior sources`);

    setProgress(0.86, 'Rigging operators');
    this.input = new Input(el.canvas);
    this.player = new PlayerController(this.map, this.camera, this.input);
    const spawn = this.map.spawns.attack[0]?.points[0] ?? { x: 0, y: 0, z: 12 };
    this.player.teleport(spawn.x, spawn.y + 0.1, spawn.z, Math.PI);

    // A third-person body for the local player, kept for the spectator and killcam views.
    // Hidden in first person: the camera sits at eye height *inside* this mesh, so leaving
    // it visible fills the lower half of the screen with the inside of your own torso.
    this.bodyRig = createOperator({ team: 'attack' });
    this.bodyAnim = new OperatorAnimator(this.bodyRig);
    this.bodyRig.group.visible = false;
    this.scene.add(this.bodyRig.group);

    setProgress(0.94, 'Compiling shaders');
    this.spawnCamera();
    this.lighting.sun.update(this.camera);
    this.renderer.renderer.compile(this.scene, this.camera);

    setProgress(1.0, 'Ready');
  }

  /** Drops the camera on the courtyard's south edge looking across it. */
  spawnCamera() {
    this.camera.position.set(0, 1.65, 8.5);
    this.camera.rotation.set(0, 0, 0, 'YXZ');
  }

  start() {
    this.running = true;
    this.clock.start();
    this.renderer.markShadowsDirty();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.update(dt);
    // Driving a drone renders from its camera instead of the player's eyes.
    const cam = this.session?.activeCamera ?? this.camera;
    if (cam !== this._lastCam) {
      cam.aspect = this.camera.aspect;
      cam.updateProjectionMatrix();
      this._lastCam = cam;
      this.renderer.resetHistory();
    }
    this._renderCam = cam;

    const lc = this._renderCam ?? this.camera;
    this.lighting.sun.update(lc);
    this.lighting.interior.update(lc.position);
    this.renderer.markShadowsDirty();

    const rc = this._renderCam ?? this.camera;
    this.renderer.applyJitter(rc);
    this.renderer.render(this.scene, rc, dt);
    // Viewmodel draws last, over the resolved frame, with depth cleared so the weapon
    // never intersects world geometry. Not while piloting the drone — there are no hands.
    if (!this.session?.driving) this.session?.render(this.renderer.renderer);
  }

  /** Starts a match from the shell. Online matches additionally bring up net and voice. */
  async beginMatch({ offline = true, profile, lobby, isHost, user, voice = true } = {}) {
    this.session = new Session(this);
    this.session.setup({
      localName: profile?.username ?? 'OPERATOR',
      // Online lobbies fill with real players; bots only pad an offline match.
      botCount: offline ? 9 : 9,
      loadout: profile?.loadouts?.default,
      skins: profile?.skins ?? {},
      banner: profile?.banner,
    });
    this.renderer.resetHistory();

    if (!offline && lobby && user) {
      const [{ NetBridge }, { VoiceChat }, { audio }] = await Promise.all([
        import('./net/bridge.js'), import('./net/voice.js'), import('./core/audio.js'),
      ]);
      const bridge = new NetBridge(this.session, { lobby, isHost, user, profile });
      this.session.net = bridge;
      await bridge.start();

      if (voice) {
        const vc = new VoiceChat(audio, this.map);
        this.session.voice = vc;
        const stream = await vc.startCapture({ pushToTalk: false });
        if (stream) await bridge.transport.attachVoice(stream);
      }
    }
    return this.session;
  }

  update(dt) {
    // Slow orbit behind the menu.
    if (this.menuOrbit) {
      this._orbit = (this._orbit ?? 0) + dt * 0.045;
      const r = 30;
      this.camera.position.set(Math.sin(this._orbit) * r, 11 + Math.sin(this._orbit * 0.6) * 2.5, Math.cos(this._orbit) * r);
      this.camera.lookAt(0, 3.5, 0);
      return;
    }
    if (!this.player || !this.session) return;
    const cmd = this.input.poll(this.player.ads);

    /**
     * Movement runs on a fixed timestep, accumulated against real time.
     *
     * Feeding a variable frame delta straight into the controller made movement visibly
     * choppy: collide-and-slide sub-steps, ground snapping and acceleration all behave
     * differently at 8 ms than at 30 ms, so any frame-time jitter turned into position
     * jitter. A fixed step means the simulation is identical every tick and only the
     * number of ticks varies.
     */
    this._accum = (this._accum ?? 0) + dt;
    const STEP = 1 / 120;
    let steps = 0;
    while (this._accum >= STEP && steps < 8) {
      this.player.update(STEP, cmd);
      this._accum -= STEP;
      steps++;
      // Look and one-shot actions must not be applied more than once per frame.
      cmd.lookX = 0; cmd.lookY = 0;
      cmd.jump = false; cmd.firePressed = false;
    }
    // A long stall (tab switch, GC pause) would otherwise spend minutes catching up.
    if (this._accum > 0.25) this._accum = 0;

    this.session.update(dt, cmd);

    // Drive the third-person body from the controller's state. It is offset behind the
    // camera's eye so the local player never sees the inside of their own head.
    const p = this.player;
    this.bodyRig.group.position.set(p.position.x, p.position.y, p.position.z);
    this.bodyRig.group.rotation.y = p.yaw;
    this.bodyAnim.update(dt, {
      speed: p.speed,
      grounded: p.grounded,
      crouch: p.stance === 1 ? 1 : p.stance === 2 ? 1.35 : 0,
      lean: p.lean,
      pitch: p.pitch,
      aim: p.ads,
    });

    if (cmd.menu) this.input.releaseLock();
  }

  /**
   * Live grade/lighting tuning without a reload. Dev affordance — the shipped values live
   * in the renderer's `grade` defaults and the lighting presets.
   */
  tune(patch = {}) {
    const g = this.renderer.grade;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'skyExposure') this.lighting.sky.material.uniforms.uExposure.value = v;
      else if (k === 'turbidity') this.lighting.sky.material.uniforms.uTurbidity.value = v;
      else if (k === 'rayleigh') this.lighting.sky.material.uniforms.uRayleigh.value = v;
      else if (k === 'envIntensity') this.scene.environmentIntensity = v;
      else if (k === 'sunIntensity') this.lighting.sun.setIntensity(v);
      else if (k === 'hemi') this.lighting.hemi.intensity = v;
      else if (k === 'fogDensity') this.scene.fog.density = v;
      else if (k === 'aoRadius') this.renderer.matGTAO.uniforms.uRadius.value = v;
      else if (k === 'aoIntensity') this.renderer.matGTAO.uniforms.uIntensity.value = v;
      else if (g[k] !== undefined) {
        if (g[k].isVector3) g[k].fromArray(v); else g[k] = v;
      }
    }
    this.renderer.resetHistory();
    return {
      exposure: g.exposure, bloom: g.bloom, ao: g.ao, vignette: g.vignette,
      saturation: g.saturation, contrast: g.contrast,
      skyExposure: this.lighting.sky.material.uniforms.uExposure.value,
      envIntensity: this.scene.environmentIntensity,
      sunIntensity: this.lighting.sun.lights[0].intensity,
      aoRadius: this.renderer.matGTAO.uniforms.uRadius.value,
      aoIntensity: this.renderer.matGTAO.uniforms.uIntensity.value,
    };
  }

  /** Renders a single post buffer to disk so individual passes can be inspected. */
  async captureBuffer(which, name) {
    const r = this.renderer;
    const src = { ao: r.rtAO, normal: r.rtNormal, scene: r.rtScene, bloom: r.bloomRTs[0] }[which];
    if (!src) return { error: 'unknown buffer ' + which };
    r.matCopy.uniforms.tInput.value = src.texture;
    r.blit(r.matCopy, null);
    const blob = await new Promise((res) => el.canvas.toBlob(res, 'image/png'));
    return (await fetch(`/__shot/${name}`, { method: 'POST', body: blob })).json();
  }

  /**
   * Dev-only framebuffer capture. `preserveDrawingBuffer` is off for performance, so the
   * read has to happen in the same task as the draw — hence the explicit render here
   * rather than relying on the animation loop's last frame.
   */
  async capture(name = 'shot.png', { x, y, z, yaw, pitch, fov, target } = {}) {
    if (x !== undefined) this.camera.position.set(x, y, z);
    if (target) {
      // Derive yaw/pitch from a look-at target so shots can be aimed at a place rather
      // than by hand-solving angles (and getting the sign wrong).
      const d = new THREE.Vector3(target[0], target[1], target[2]).sub(this.camera.position);
      yaw = Math.atan2(-d.x, -d.z);
      pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    }
    if (yaw !== undefined) {
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotateY(yaw);
      this.camera.rotateX(pitch ?? 0);
      if (this.controller) { this.controller.state.yaw = yaw; this.controller.state.pitch = pitch ?? 0; }
    }
    if (fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // The viewmodel only takes up its carry pose inside its own update(); without this it
    // sits at the viewmodel camera's origin and fills the frame.
    for (let i = 0; i < 12; i++) {
      this.session?.viewmodel.update(1 / 60, {
        ads: this.player?.ads ?? 0, speed: 0, grounded: true, lookDX: 0, lookDY: 0,
      });
    }

    // TAA needs a few frames to converge before the shot is representative.
    this.renderer.resetHistory();
    for (let i = 0; i < 8; i++) {
      this.lighting.sun.update(this.camera);
      this.lighting.interior.update(this.camera.position);
      this.renderer.markShadowsDirty();
      this.renderer.applyJitter(this.camera);
      this.renderer.render(this.scene, this.camera, 1 / 60);
      this.session?.render(this.renderer.renderer);
    }

    const blob = await new Promise((r) => el.canvas.toBlob(r, 'image/png'));
    const res = await fetch(`/__shot/${name}`, { method: 'POST', body: blob });
    return res.json();
  }
}

/* ================================================================== boot */

async function boot() {
  el.loadtip.innerHTML = TIPS[Math.floor(Math.random() * TIPS.length)];

  // 1. Title card starts immediately.
  const introDone = new Promise((resolve) => {
    playIntro(el.bootCanvas, { onDone: resolve });
  });

  // 2. Engine boots and assets stream while it plays.
  const app = new App();
  window.__FL = app;   // handy for console poking during development
  const loaded = app.load().catch((e) => { fatal(e); throw e; });

  await introDone;
  el.boot.classList.add('done');
  el.loader.classList.add('show');
  setTimeout(() => { el.boot.style.display = 'none'; }, 550);

  await loaded;

  // 3. Hand off.
  await new Promise((r) => setTimeout(r, 260));
  el.loader.classList.remove('show');
  setTimeout(() => { el.loader.style.display = 'none'; }, 500);

  app.start();

  const { audio } = await import('./core/audio.js');

  // The menu runs over a slow orbit of the map, so the shell is never a flat background.
  app.camera.position.set(0, 8.5, 26);
  app.camera.lookAt(0, 3, 0);
  app.menuOrbit = true;

  // Pointer lock has to originate from a user gesture, so prompt rather than grab it.
  const prompt = document.createElement('div');
  prompt.id = 'clickprompt';
  prompt.style.display = 'none';
  prompt.innerHTML = '<b>CLICK TO DEPLOY</b><span>WASD move &middot; Shift sprint &middot; Ctrl crouch &middot; Q/E lean &middot; Esc release</span>';
  el.ui.appendChild(prompt);
  const grab = async () => {
    // Browsers only allow an AudioContext to start from a user gesture, so this is the
    // first opportunity to bring sound up.
    await audio.init();
    audio.startAmbience();
    app.input.requestLock();
  };
  prompt.addEventListener('click', grab);
  el.canvas.addEventListener('click', () => { if (app.session) grab(); });
  document.addEventListener('pointerlockchange', () => {
    if (app.session) prompt.style.display = app.input.locked ? 'none' : '';
  });

  const shell = new Shell(el.ui, app);
  app.shell = shell;
  shell.onStartMatch = async (opts) => {
    await audio.init();
    audio.startAmbience();
    app.menuOrbit = false;
    await app.beginMatch(opts);
    prompt.style.display = '';
  };
  await shell.start();
}

boot().catch(fatal);
