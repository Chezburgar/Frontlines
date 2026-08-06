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
  }

  async load() {
    setProgress(0.02, 'Connecting');

    setProgress(0.05, 'Streaming Luna Park');
    await this.map.load(
      `${BASE}models/lunapark.glb`,
      `${BASE}models/lunapark.nav.json`,
      (p) => setProgress(0.05 + p * 0.65, 'Streaming Luna Park'),
    );
    this.scene.add(this.map.root);
    console.info(`[map] ${this.map.chunks.length} chunks, ` +
      `${this.map.triangleCount.toLocaleString()} tris, ` +
      `${this.map.vertexCount.toLocaleString()} verts`);

    setProgress(0.76, 'Building light rig');
    this.lighting = buildLighting(this.scene, this.renderer.renderer, 'afternoon', QUALITY[this.quality]);
    const lampCount = this.lighting.interior.buildFromNav(this.map.nav);
    console.info(`[lighting] ${lampCount} interior sources`);

    setProgress(0.9, 'Compiling shaders');
    // Place the camera somewhere inside before the first compile so the warm-up actually
    // touches the materials that will be used.
    this.spawnCamera();
    this.lighting.sun.update(this.camera);
    this.renderer.renderer.compile(this.scene, this.camera);

    setProgress(1.0, 'Ready');
  }

  /** Drops the camera into the largest analysed room on the ground storey. */
  spawnCamera() {
    const nav = this.map.nav;
    let best = null;
    if (nav?.storeys?.length) {
      for (const s of nav.storeys) {
        for (const r of s.rooms) {
          if (!best || r.area > best.area) best = { ...r, y: s.y };
        }
      }
    }
    if (best) {
      this.camera.position.set(best.centre.x, best.y + 1.65, best.centre.z);
    } else {
      const c = this.map.bounds.getCenter(new THREE.Vector3());
      this.camera.position.set(c.x, this.map.bounds.min.y + 1.65, c.z);
    }
    this.camera.lookAt(0, this.camera.position.y, 0);
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

    this.map.updateCulling(this.camera);
    this.lighting.sun.update(this.camera);
    this.lighting.interior.update(this.camera.position);
    this.map.updateShadowCasters(this.camera.position, QUALITY[this.quality].shadowDistance);
    this.renderer.markShadowsDirty();

    this.renderer.applyJitter(this.camera);
    this.renderer.render(this.scene, this.camera, dt);
  }

  /** Overridden once the player controller exists; free-look orbit for bring-up. */
  update(dt) {
    if (this.controller) this.controller.update(dt);
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
  async capture(name = 'shot.png', { x, y, z, yaw, pitch, fov } = {}) {
    if (x !== undefined) this.camera.position.set(x, y, z);
    if (yaw !== undefined) {
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotateY(yaw);
      this.camera.rotateX(pitch ?? 0);
      if (this.controller) { this.controller.state.yaw = yaw; this.controller.state.pitch = pitch ?? 0; }
    }
    if (fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // TAA needs a few frames to converge before the shot is representative.
    this.renderer.resetHistory();
    for (let i = 0; i < 8; i++) {
      this.map.updateCulling(this.camera);
      this.lighting.sun.update(this.camera);
      this.lighting.interior.update(this.camera.position);
      this.renderer.markShadowsDirty();
      this.renderer.applyJitter(this.camera);
      this.renderer.render(this.scene, this.camera, 1 / 60);
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

  const { attachFreeCam } = await import('./core/freecam.js');
  app.controller = attachFreeCam(app.camera, el.canvas, app.renderer);
}

boot().catch(fatal);
