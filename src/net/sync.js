/**
 * Netcode: snapshot replication and input forwarding.
 *
 * Host authority. Clients predict their own movement locally and send inputs upstream; the
 * host simulates everything, resolves all damage, and broadcasts snapshots. Clients
 * reconcile their predicted position against the host's and interpolate every other
 * entity, so remote players move smoothly on a 20 Hz snapshot rate.
 *
 * Snapshots are packed into a binary format rather than JSON — a 10-player snapshot is
 * ~250 bytes packed against ~1.8 kB as JSON, which matters at 20 Hz over an unreliable
 * channel with a 1200-byte practical MTU.
 */

export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 60;

/* Quantisation. The map is ~80 m across and ~12 m tall, so 16 bits of position at 1 cm
 * resolution covers it with room to spare. */
const POS_SCALE = 100;      // cm
const ANG_SCALE = 10430;    // radians -> int16 (pi -> ~32767)

const MSG = { SNAPSHOT: 1, INPUT: 2, EVENT: 3, HIT: 4 };

/* ------------------------------------------------------------------ writer */

class Writer {
  constructor(size = 1400) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.off = 0;
  }
  u8(v) { this.view.setUint8(this.off, v); this.off += 1; }
  i16(v) { this.view.setInt16(this.off, v, true); this.off += 2; }
  u16(v) { this.view.setUint16(this.off, v, true); this.off += 2; }
  u32(v) { this.view.setUint32(this.off, v, true); this.off += 4; }
  f32(v) { this.view.setFloat32(this.off, v, true); this.off += 4; }
  done() { return this.buf.slice(0, this.off); }
}

class Reader {
  constructor(buf) { this.view = new DataView(buf); this.off = 0; }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  get remaining() { return this.view.byteLength - this.off; }
}

/* --------------------------------------------------------------- snapshots */

/**
 * Packs the authoritative world state.
 * Player slots are indices into a roster the host sends over the reliable channel on join,
 * so names and cosmetics never ride the hot path.
 */
export function writeSnapshot(tick, players, match) {
  const w = new Writer();
  w.u8(MSG.SNAPSHOT);
  w.u32(tick);
  w.u8(match.phase.charCodeAt(0));          // first letter is unique across phases
  w.u16(Math.round(match.timeLeft * 10));
  w.u8(match.round);
  w.u8(match.score[0]); w.u8(match.score[1]);
  w.u8(match.bomb.planted ? 1 : 0);

  const list = [...players.values()];
  w.u8(list.length);
  for (const p of list) {
    w.u8(p.netIndex ?? 0);
    // Flags: alive / dbno / aiming / firing / crouch
    let flags = 0;
    if (p.alive) flags |= 1;
    if (p.dbno) flags |= 2;
    if (p.aiming) flags |= 4;
    if (p.firing) flags |= 8;
    if (p.stance === 1) flags |= 16;
    if (p.stance === 2) flags |= 32;
    w.u8(flags);
    w.i16(Math.round(p.position.x * POS_SCALE));
    w.i16(Math.round(p.position.y * POS_SCALE));
    w.i16(Math.round(p.position.z * POS_SCALE));
    w.i16(Math.round((p.yaw ?? 0) * ANG_SCALE / Math.PI * 3.14159 / 3.14159));
    w.i16(Math.round((p.pitch ?? 0) * ANG_SCALE / Math.PI * 3.14159 / 3.14159));
    w.u8(Math.max(0, Math.min(255, Math.round(p.health ?? 0))));
    w.u8(p.slot ?? 0);
  }
  return w.done();
}

export function readSnapshot(buf) {
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== MSG.SNAPSHOT) return null;
  const snap = {
    tick: r.u32(),
    phaseChar: String.fromCharCode(r.u8()),
    timeLeft: r.u16() / 10,
    round: r.u8(),
    score: [r.u8(), r.u8()],
    planted: !!r.u8(),
    players: [],
  };
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const netIndex = r.u8();
    const flags = r.u8();
    snap.players.push({
      netIndex,
      alive: !!(flags & 1),
      dbno: !!(flags & 2),
      aiming: !!(flags & 4),
      firing: !!(flags & 8),
      stance: (flags & 16) ? 1 : (flags & 32) ? 2 : 0,
      x: r.i16() / POS_SCALE,
      y: r.i16() / POS_SCALE,
      z: r.i16() / POS_SCALE,
      yaw: r.i16() / ANG_SCALE,
      pitch: r.i16() / ANG_SCALE,
      health: r.u8(),
      slot: r.u8(),
    });
  }
  return snap;
}

/* ------------------------------------------------------------------ inputs */

/** Clients send this at 60 Hz; the host replays it against its own simulation. */
export function writeInput(seq, cmd, controller) {
  const w = new Writer(64);
  w.u8(MSG.INPUT);
  w.u32(seq);
  let bits = 0;
  if (cmd.fire) bits |= 1;
  if (cmd.aim) bits |= 2;
  if (cmd.jump) bits |= 4;
  if (cmd.crouch) bits |= 8;
  if (cmd.prone) bits |= 16;
  if (cmd.sprint) bits |= 32;
  if (cmd.reload) bits |= 64;
  if (cmd.interactHeld) bits |= 128;
  w.u8(bits);
  w.u8(cmd.leanLeft ? 1 : cmd.leanRight ? 2 : 0);
  // Movement axes quantised to a byte each — full precision is meaningless for a stick.
  w.u8(Math.round((cmd.move.x + 1) * 127));
  w.u8(Math.round((cmd.move.y + 1) * 127));
  w.i16(Math.round(controller.yaw * ANG_SCALE));
  w.i16(Math.round(controller.pitch * ANG_SCALE));
  // Predicted position, so the host can measure divergence rather than trust it.
  w.i16(Math.round(controller.position.x * POS_SCALE));
  w.i16(Math.round(controller.position.y * POS_SCALE));
  w.i16(Math.round(controller.position.z * POS_SCALE));
  return w.done();
}

export function readInput(buf) {
  const r = new Reader(buf);
  if (r.u8() !== MSG.INPUT) return null;
  const seq = r.u32();
  const bits = r.u8();
  const lean = r.u8();
  return {
    seq,
    fire: !!(bits & 1), aim: !!(bits & 2), jump: !!(bits & 4),
    crouch: !!(bits & 8), prone: !!(bits & 16), sprint: !!(bits & 32),
    reload: !!(bits & 64), interactHeld: !!(bits & 128),
    leanLeft: lean === 1, leanRight: lean === 2,
    move: { x: r.u8() / 127 - 1, y: r.u8() / 127 - 1 },
    yaw: r.i16() / ANG_SCALE,
    pitch: r.i16() / ANG_SCALE,
    px: r.i16() / POS_SCALE, py: r.i16() / POS_SCALE, pz: r.i16() / POS_SCALE,
  };
}

/* ---------------------------------------------------------- interpolation */

/**
 * Buffers snapshots and plays them back on a delay so remote entities move smoothly
 * between them. The delay is one snapshot interval plus a margin — enough to hide
 * ordinary jitter without making everyone feel laggy to shoot at.
 */
export class SnapshotBuffer {
  constructor(delayMs = 1000 / SNAPSHOT_HZ * 1.8) {
    this.delay = delayMs;
    this.snaps = [];
    this.maxHeld = 24;
  }

  push(snap) {
    snap.recvAt = performance.now();
    this.snaps.push(snap);
    // Out-of-order arrival is normal on an unreliable channel.
    this.snaps.sort((a, b) => a.tick - b.tick);
    while (this.snaps.length > this.maxHeld) this.snaps.shift();
  }

  /** Returns interpolated player states for "now minus delay", or null if starved. */
  sample() {
    if (this.snaps.length < 2) return this.snaps[this.snaps.length - 1] ?? null;
    const target = performance.now() - this.delay;
    let a = null, b = null;
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].recvAt <= target && this.snaps[i + 1].recvAt >= target) {
        a = this.snaps[i]; b = this.snaps[i + 1]; break;
      }
    }
    // Starved: hold the newest rather than snapping backwards.
    if (!a) return this.snaps[this.snaps.length - 1];

    const span = b.recvAt - a.recvAt;
    const t = span > 0 ? (target - a.recvAt) / span : 0;
    const byIndex = new Map(b.players.map((p) => [p.netIndex, p]));
    const players = a.players.map((pa) => {
      const pb = byIndex.get(pa.netIndex);
      if (!pb) return pa;
      return {
        ...pb,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        z: pa.z + (pb.z - pa.z) * t,
        yaw: pa.yaw + shortestAngle(pa.yaw, pb.yaw) * t,
        pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      };
    });
    return { ...b, players };
  }

  clear() { this.snaps.length = 0; }
}

function shortestAngle(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ------------------------------------------------------------ reconciliation */

/**
 * Client-side prediction with server reconciliation.
 *
 * The client keeps every input it has sent since the last acknowledged one. When a
 * snapshot arrives it snaps to the host's position and replays the unacknowledged inputs,
 * so a correction costs one frame of simulation rather than a visible rubber-band.
 */
export class Predictor {
  constructor(controller) {
    this.controller = controller;
    this.pending = [];
    this.seq = 0;
    this.threshold = 0.22;    // metres of divergence before a correction is applied
  }

  record(cmd) {
    this.seq++;
    this.pending.push({ seq: this.seq, cmd: { ...cmd, move: { ...cmd.move } } });
    if (this.pending.length > 240) this.pending.shift();
    return this.seq;
  }

  /** @param {{x,y,z,seq}} authoritative state from the host */
  reconcile(auth, dt) {
    const c = this.controller;
    const dx = c.position.x - auth.x, dy = c.position.y - auth.y, dz = c.position.z - auth.z;
    const err = Math.hypot(dx, dy, dz);
    this.pending = this.pending.filter((p) => p.seq > auth.seq);
    if (err < this.threshold) return err;

    c.position.set(auth.x, auth.y, auth.z);
    // Replay everything the host has not seen yet.
    for (const p of this.pending) c.update(dt, p.cmd);
    return err;
  }
}
