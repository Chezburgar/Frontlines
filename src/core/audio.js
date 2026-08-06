/**
 * Audio engine.
 *
 * Every sound is synthesised at runtime rather than shipped as samples. That keeps the
 * download at zero bytes, lets each weapon derive its report from its own ballistics, and
 * — the reason that matters most here — means a gunshot heard through two walls can be
 * filtered from the same source that produced the dry shot, instead of needing a separate
 * "muffled" sample per weapon.
 *
 * A gunshot is built the way a real one reads on a recording:
 *   - a very short broadband transient (the crack of the muzzle blast),
 *   - a low-frequency body thump with a fast exponential decay,
 *   - a mechanical action layer (bolt, ejection),
 *   - a convolved tail whose impulse response is generated from the room around you.
 *
 * Nothing here is a cartoon "pew" — the envelopes are all sub-100 ms attack with the
 * energy weighted low, which is what makes a shot sound like a pressure event.
 */
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.buffers = new Map();
    this.listenerPos = new THREE.Vector3();
    this.volumes = { master: 0.85, sfx: 1.0, voice: 1.0, music: 0.5 };
    this._noiseCache = new Map();
  }

  /** Must be called from a user gesture — browsers refuse to start audio otherwise. */
  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return this; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // A gentle limiter stops a burst of simultaneous gunfire from clipping.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;

    // Shared reverb send: one convolver for the whole mix rather than per-voice.
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulseResponse(1.55, 2.6);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.30;

    this.sfxBus.connect(this.limiter);
    this.sfxBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.listener = this.ctx.listener;
    this.ready = true;
    return this;
  }

  setVolume(key, v) {
    this.volumes[key] = clamp(v, 0, 1);
    if (!this.ready) return;
    if (key === 'master') this.master.gain.value = this.volumes.master;
    if (key === 'sfx') this.sfxBus.gain.value = this.volumes.sfx;
  }

  /** Updates the 3D listener from the camera each frame. */
  updateListener(camera) {
    if (!this.ready) return;
    camera.getWorldPosition(this.listenerPos);
    const l = this.listener;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(this.listenerPos.x, t, 0.02);
      l.positionY.setTargetAtTime(this.listenerPos.y, t, 0.02);
      l.positionZ.setTargetAtTime(this.listenerPos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /* ------------------------------------------------------------- generators */

  _noise(seconds, seed = 1) {
    const key = `${seconds.toFixed(3)}_${seed}`;
    if (this._noiseCache.has(key)) return this._noiseCache.get(key);
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = seed * 9301 + 49297;
    for (let i = 0; i < n; i++) {
      s = (s * 9301 + 49297) % 233280;
      d[i] = (s / 233280) * 2 - 1;
    }
    this._noiseCache.set(key, buf);
    return buf;
  }

  /**
   * Synthetic room impulse: exponentially decaying noise with an early-reflection cluster.
   * Cheap, and close enough that a shot indoors reads as indoors.
   */
  _impulseResponse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let s = 12345 + ch * 777;
      for (let i = 0; i < n; i++) {
        s = (s * 9301 + 49297) % 233280;
        const white = (s / 233280) * 2 - 1;
        d[i] = white * Math.pow(1 - i / n, decay);
      }
      // Early reflections give the tail a sense of wall distance.
      for (const [ms, gain] of [[11, 0.55], [19, 0.42], [31, 0.3], [43, 0.22], [67, 0.15]]) {
        const at = Math.floor((ms / 1000) * rate);
        if (at < n) d[at] += gain * (ch ? -1 : 1);
      }
    }
    return buf;
  }

  /* ----------------------------------------------------------------- voices */

  /**
   * Builds a positional voice.
   * `occlusion` (0..1) lowpasses and attenuates — this is how a shot two rooms away
   * becomes a muffled thump without a second sample.
   */
  _voice({ position, refDistance = 6, maxDistance = 110, rolloff = 1.1, occlusion = 0, gain = 1 }) {
    const out = this.ctx.createGain();
    out.gain.value = gain * (1 - occlusion * 0.55);

    let node = out;
    if (occlusion > 0.02) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      // Fully occluded lands around 420 Hz — audible, directional, clearly through a wall.
      lp.frequency.value = 18000 * Math.pow(0.023, occlusion);
      lp.Q.value = 0.7;
      out.connect(lp);
      node = lp;
    }

    if (position) {
      const pan = this.ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = refDistance;
      pan.maxDistance = maxDistance;
      pan.rolloffFactor = rolloff;
      if (pan.positionX) {
        pan.positionX.value = position.x;
        pan.positionY.value = position.y;
        pan.positionZ.value = position.z;
      } else pan.setPosition(position.x, position.y, position.z);
      node.connect(pan);
      pan.connect(this.sfxBus);
    } else {
      node.connect(this.sfxBus);
    }
    return out;
  }

  /* ------------------------------------------------------------------ sounds */

  /**
   * Gunshot.
   * @param {object} o { position, weapon, occlusion, firstPerson, suppressed }
   */
  gunshot({ position, weapon, occlusion = 0, firstPerson = false, suppressed = false }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const cal = weapon?.penetration ?? 10;          // stands in for calibre/power
    const loud = (weapon?.loudness ?? 1) * (suppressed ? 0.42 : 1);

    const dest = this._voice({
      position: firstPerson ? null : position,
      refDistance: 8, maxDistance: 140, rolloff: 1.25,
      occlusion, gain: (firstPerson ? 0.55 : 0.9) * loud,
    });

    // --- 1. transient: the crack. Very short, broadband, highpassed.
    const crackLen = suppressed ? 0.05 : 0.09;
    const crack = this.ctx.createBufferSource();
    crack.buffer = this._noise(crackLen, 3 + (cal | 0));
    const crackHP = this.ctx.createBiquadFilter();
    crackHP.type = 'highpass';
    crackHP.frequency.value = suppressed ? 900 : 1500;
    const crackEnv = this.ctx.createGain();
    crackEnv.gain.setValueAtTime(0.0001, t);
    crackEnv.gain.exponentialRampToValueAtTime(suppressed ? 0.35 : 1.0, t + 0.0012);
    crackEnv.gain.exponentialRampToValueAtTime(0.0001, t + crackLen);
    crack.connect(crackHP); crackHP.connect(crackEnv); crackEnv.connect(dest);
    crack.start(t); crack.stop(t + crackLen + 0.01);

    // --- 2. body: low thump. Bigger calibre -> lower and longer.
    const bodyLen = suppressed ? 0.12 : 0.22 + cal * 0.004;
    const body = this.ctx.createBufferSource();
    body.buffer = this._noise(bodyLen, 7 + (cal | 0));
    const bodyLP = this.ctx.createBiquadFilter();
    bodyLP.type = 'lowpass';
    bodyLP.frequency.setValueAtTime(1400 - cal * 22, t);
    bodyLP.frequency.exponentialRampToValueAtTime(180, t + bodyLen);
    bodyLP.Q.value = 1.4;
    const bodyEnv = this.ctx.createGain();
    bodyEnv.gain.setValueAtTime(0.0001, t);
    bodyEnv.gain.exponentialRampToValueAtTime(suppressed ? 0.30 : 0.95, t + 0.004);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, t + bodyLen);
    body.connect(bodyLP); bodyLP.connect(bodyEnv); bodyEnv.connect(dest);
    body.start(t); body.stop(t + bodyLen + 0.01);

    // --- 3. sub: the pressure you feel more than hear.
    if (!suppressed) {
      const sub = this.ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(150 - cal * 1.4, t);
      sub.frequency.exponentialRampToValueAtTime(46, t + 0.12);
      const subEnv = this.ctx.createGain();
      subEnv.gain.setValueAtTime(0.0001, t);
      subEnv.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
      subEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      sub.connect(subEnv); subEnv.connect(dest);
      sub.start(t); sub.stop(t + 0.18);
    }

    // --- 4. mechanical action, slightly delayed like a real bolt cycling.
    this._click(dest, t + 0.035, 2400, 0.16, 0.03);
  }

  _click(dest, at, freq, gain, len = 0.02) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(len, Math.floor(freq));
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.4;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.0015);
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(bp); bp.connect(env); env.connect(dest);
    src.start(at); src.stop(at + len + 0.01);
  }

  /** Footstep. Character comes from the surface's filter shape, not a different sample. */
  footstep({ position, surface = 'stone', occlusion = 0, running = false, gain = 1 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({
      position, refDistance: 3, maxDistance: 34, rolloff: 1.8,
      occlusion, gain: gain * (running ? 0.85 : 0.5),
    });

    // Per-surface: [centre frequency, Q, length, lowpass]
    const S = {
      wood: [520, 1.1, 0.10, 4200],
      stone: [900, 0.9, 0.07, 6500],
      tile: [1400, 1.6, 0.06, 8000],
      gravel: [2600, 0.5, 0.14, 9000],
      soft: [300, 0.8, 0.09, 1800],   // tatami
      metal: [1800, 3.0, 0.13, 7000],
    }[surface] ?? [800, 1.0, 0.08, 5000];

    const [freq, q, len, lp] = S;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(len, Math.floor(freq + Math.random() * 90));
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * (0.85 + Math.random() * 0.3); bp.Q.value = q;
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowpass'; low.frequency.value = lp;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.55, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(bp); bp.connect(low); low.connect(env); env.connect(dest);
    src.start(t); src.stop(t + len + 0.01);
  }

  /** Bullet impact on a surface. */
  impact({ position, surface = 'plaster', occlusion = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({ position, refDistance: 4, maxDistance: 45, occlusion, gain: 0.7 });
    const S = {
      plaster: [1600, 0.9, 0.10], stone: [2600, 1.6, 0.07],
      woodFloor: [900, 1.1, 0.11], woodBeam: [700, 1.2, 0.12],
      metal: [3200, 5.0, 0.30], shoji: [3000, 0.7, 0.05],
      fusuma: [1200, 0.8, 0.07], tatami: [420, 0.7, 0.08],
      gravel: [3000, 0.5, 0.10], roofTile: [2200, 2.2, 0.12],
    }[surface] ?? [1500, 1.0, 0.09];
    const [freq, q, len] = S;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(len, Math.floor(freq));
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq * (0.8 + Math.random() * 0.4); bp.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.7, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(bp); bp.connect(env); env.connect(dest);
    src.start(t); src.stop(t + len + 0.02);
  }

  /** Reload: a sequence of mechanical clicks rather than one blurry noise. */
  reload({ position, empty = false, shell = false, occlusion = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({ position, refDistance: 3, maxDistance: 26, occlusion, gain: 0.6 });
    if (shell) {
      this._click(dest, t + 0.02, 1500, 0.30, 0.05);
      this._click(dest, t + 0.20, 2600, 0.22, 0.03);
      return;
    }
    this._click(dest, t + 0.02, 900, 0.30, 0.05);        // magazine release
    this._click(dest, t + 0.55, 700, 0.34, 0.07);        // magazine seated
    if (empty) this._click(dest, t + 1.05, 2600, 0.30, 0.05);  // bolt release
  }

  /** Bullet passing close to the listener — the snap that makes being shot at legible. */
  crack({ position, occlusion = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({ position, refDistance: 3, maxDistance: 24, occlusion, gain: 0.5 });
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(0.045, 991);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2200;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.9, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(hp); hp.connect(env); env.connect(dest);
    src.start(t); src.stop(t + 0.06);
  }

  /** UI tick — deliberately dry and quiet. */
  ui(kind = 'tick') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({ position: null, gain: 0.35 });
    const f = { tick: 2200, confirm: 1400, deny: 380, plant: 900 }[kind] ?? 1800;
    this._click(dest, t, f, 0.25, kind === 'deny' ? 0.10 : 0.03);
  }

  /** Long, slow beep for a live charge. */
  bombBeep({ position, urgency = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this._voice({ position, refDistance: 6, maxDistance: 60, gain: 0.5 });
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1250 + urgency * 500;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    osc.connect(env); env.connect(dest);
    osc.start(t); osc.stop(t + 0.12);
  }

  /** Ambient bed: wind plus a slow filtered noise wash. Started once, runs for the match. */
  startAmbience() {
    if (!this.ready || this._ambience) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise(6, 4242);
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
    const g = this.ctx.createGain();
    g.gain.value = 0.045;
    // Slow LFO on the cutoff so the wind breathes rather than sitting static.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    src.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    src.start(); lfo.start();
    this._ambience = { src, lfo, g };
  }

  stopAmbience() {
    if (!this._ambience) return;
    try { this._ambience.src.stop(); this._ambience.lfo.stop(); } catch { /* already stopped */ }
    this._ambience = null;
  }

  /**
   * Occlusion between the listener and a point, as a 0..1 value.
   * Counts how many surfaces the straight line crosses rather than doing a proper
   * acoustic solve — cheap, stable, and it produces the right ordering: same room, one
   * wall, deep in the building.
   */
  occlusionTo(map, point, maxWalls = 3) {
    if (!map) return 0;
    const from = this.listenerPos;
    const dir = new THREE.Vector3().subVectors(point, from);
    const dist = dir.length();
    if (dist < 0.5) return 0;
    dir.divideScalar(dist);

    let walls = 0;
    let travelled = 0;
    const p = from.clone();
    for (let i = 0; i < maxWalls; i++) {
      const hit = map.raycast(p, dir, dist - travelled);
      if (!hit) break;
      walls++;
      travelled += hit.distance + 0.08;
      p.copy(hit.point).addScaledVector(dir, 0.08);
      if (travelled >= dist) break;
    }
    return clamp(walls / maxWalls, 0, 1);
  }
}

export const audio = new AudioEngine();
