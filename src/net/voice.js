/**
 * Proximity voice chat.
 *
 * Each peer's microphone rides the same RTCPeerConnection the game state uses, so voice
 * needs no extra connection or server. The received stream is routed through the same
 * spatial pipeline gunfire uses — a panner for direction, distance attenuation, and a
 * lowpass driven by how many walls sit between you — so someone talking two rooms away
 * sounds like it, and you can locate a voice the way you locate a footstep.
 *
 * Local capture runs through a noise gate so an open mic in a quiet room transmits
 * nothing, which is what makes always-on proximity chat tolerable.
 */
import * as THREE from 'three';

const GATE_OPEN = 0.012;     // RMS above which the gate opens
const GATE_CLOSE = 0.006;    // hysteresis, so a breath does not chatter it
const GATE_HOLD = 0.35;      // seconds to stay open after dropping below

export class VoiceChat {
  constructor(audioEngine, map) {
    this.audio = audioEngine;
    this.map = map;
    this.remotes = new Map();      // peerId -> { stream, panner, gain, filter, source }
    this.enabled = true;
    this.pushToTalk = false;
    this.transmitting = false;
    this.localStream = null;
    this.gateOpen = false;
    this.gateHeld = 0;
    this.level = 0;
  }

  /** Requests the microphone. Returns the stream to hand to the transport. */
  async startCapture({ pushToTalk = false } = {}) {
    if (this.localStream) return this.localStream;
    this.pushToTalk = pushToTalk;
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });

      const ctx = this.audio.ctx;
      const src = ctx.createMediaStreamSource(raw);

      // Analyser drives the gate and the speaking indicator.
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this._buf = new Float32Array(this.analyser.fftSize);

      // The gate itself: a gain node the update loop opens and closes.
      this.gateGain = ctx.createGain();
      this.gateGain.gain.value = 0;

      // Light band limiting — voice does not need anything below 90 Hz or above 8 kHz,
      // and cutting it saves bandwidth and reduces rumble.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 90;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 8000;

      const dest = ctx.createMediaStreamDestination();
      src.connect(this.analyser);
      src.connect(hp); hp.connect(lp); lp.connect(this.gateGain); this.gateGain.connect(dest);

      this.rawStream = raw;
      this.localStream = dest.stream;
      return this.localStream;
    } catch (err) {
      console.warn('[voice] microphone unavailable:', err.message);
      return null;
    }
  }

  stopCapture() {
    this.rawStream?.getTracks().forEach((t) => t.stop());
    this.rawStream = null;
    this.localStream = null;
  }

  /**
   * Attaches an incoming peer stream to the spatial graph.
   * The stream is also piped to a muted <audio> element: several browsers will not
   * decode a WebRTC track that is only routed through Web Audio.
   */
  attachRemote(peerId, stream) {
    if (!this.audio.ready || this.remotes.has(peerId)) return;
    const ctx = this.audio.ctx;

    const sink = document.createElement('audio');
    sink.srcObject = stream;
    sink.muted = true;
    sink.autoplay = true;
    sink.play?.().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 18000;
    const gain = ctx.createGain();
    gain.gain.value = this.audio.volumes.voice;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3.5;
    panner.maxDistance = 26;       // proximity: beyond this you simply cannot hear them
    panner.rolloffFactor = 1.6;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.audio.master);

    this.remotes.set(peerId, { stream, source, filter, gain, panner, sink, level: 0 });
  }

  detachRemote(peerId) {
    const r = this.remotes.get(peerId);
    if (!r) return;
    try { r.source.disconnect(); r.gain.disconnect(); r.panner.disconnect(); } catch { /* already gone */ }
    r.sink?.remove();
    this.remotes.delete(peerId);
  }

  /**
   * Per-frame update.
   * @param {Map} players id -> player, used to place each peer's voice in the world
   * @param {boolean} talkHeld push-to-talk key state
   */
  update(dt, players, talkHeld) {
    if (!this.audio.ready) return;

    // ---- local gate --------------------------------------------------------
    if (this.analyser && this.gateGain) {
      this.analyser.getFloatTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
      const rms = Math.sqrt(sum / this._buf.length);
      this.level = rms;

      let want;
      if (this.pushToTalk) {
        want = !!talkHeld;
      } else {
        if (rms > GATE_OPEN) { this.gateOpen = true; this.gateHeld = GATE_HOLD; }
        else if (rms < GATE_CLOSE) { this.gateHeld -= dt; if (this.gateHeld <= 0) this.gateOpen = false; }
        want = this.gateOpen;
      }
      if (!this.enabled) want = false;
      this.transmitting = want;
      // Ramp rather than switch, so the gate does not click.
      const t = this.audio.ctx.currentTime;
      this.gateGain.gain.setTargetAtTime(want ? 1 : 0, t, want ? 0.008 : 0.06);
    }

    // ---- remote placement --------------------------------------------------
    for (const [peerId, r] of this.remotes) {
      const player = [...players.values()].find((p) => p.userId === peerId || p.id === `net:${peerId}`);
      if (!player) continue;
      const p = player.position;
      const t = this.audio.ctx.currentTime;
      if (r.panner.positionX) {
        r.panner.positionX.setTargetAtTime(p.x, t, 0.05);
        r.panner.positionY.setTargetAtTime(p.y + 1.5, t, 0.05);
        r.panner.positionZ.setTargetAtTime(p.z, t, 0.05);
      } else r.panner.setPosition(p.x, p.y + 1.5, p.z);

      // Walls muffle a voice exactly as they muffle a gunshot.
      const occ = this.audio.occlusionTo(this.map, new THREE.Vector3(p.x, p.y + 1.5, p.z));
      r.filter.frequency.setTargetAtTime(18000 * Math.pow(0.03, occ), t, 0.12);
      r.gain.gain.setTargetAtTime(this.audio.volumes.voice * (1 - occ * 0.5), t, 0.12);

      // A dead player's voice is cut — otherwise the round leaks information.
      if (player.alive === false) r.gain.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on && this.gateGain) {
      this.gateGain.gain.setTargetAtTime(0, this.audio.ctx.currentTime, 0.04);
    }
  }

  dispose() {
    this.stopCapture();
    for (const id of [...this.remotes.keys()]) this.detachRemote(id);
  }
}
