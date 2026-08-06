/**
 * Session <-> transport bridge.
 *
 * Host authority in practice:
 *   - The host runs the real simulation: bots, damage, the round state machine. It packs a
 *     snapshot 20 times a second and broadcasts it on the unreliable channel.
 *   - Clients predict their own movement locally, send inputs at 60 Hz, and apply
 *     snapshots to everyone else through an interpolation buffer.
 *   - Shots are resolved by the host. A client sends "I fired along this ray at this
 *     time"; the host re-traces it. Nothing a client says about damage is trusted.
 *
 * The split exists so the same Session class runs in all three roles — offline, host and
 * client — with only this bridge deciding who is allowed to mutate what.
 */
import * as THREE from 'three';
import { Transport } from './transport.js';
import { openSignal, publishLiveMatch, heartbeatMatch, endLiveMatch } from './supabase.js';
import { writeSnapshot, readSnapshot, writeInput, readInput, SnapshotBuffer, Predictor, SNAPSHOT_HZ } from './sync.js';
import { fireRound, damageSurface } from '../game/combat.js';
import { PHASE } from '../game/match.js';

export class NetBridge {
  /**
   * @param {import('../game/session.js').Session} session
   * @param {{ lobby, isHost, user, profile }} opts
   */
  constructor(session, { lobby, isHost, user, profile }) {
    this.s = session;
    this.lobby = lobby;
    this.isHost = isHost;
    this.selfId = user.id;
    this.profile = profile;

    this.snapshots = new SnapshotBuffer();
    this.predictor = null;
    this.roster = new Map();          // netIndex -> player id
    this.byUser = new Map();          // supabase user id -> player
    this.lastSnapshotAt = 0;
    this.lastInputAt = 0;
    this.inputSeq = 0;
    this.ackSeq = 0;
    this.connected = false;

    this.signal = openSignal(lobby.id, this.selfId);
    this.transport = new Transport({
      selfId: this.selfId,
      isHost,
      signal: this.signal,
      handlers: {
        onState: (from, buf) => this.onState(from, buf),
        onEvent: (from, msg) => this.onEvent(from, msg),
        onPeerLeave: (id) => this.onPeerLeave(id),
        onVoice: (id, stream) => this.s.voice?.attachRemote(id, stream),
      },
    });
  }

  async start() {
    if (this.isHost) {
      // The host owns the roster and publishes the match so spectators can find it.
      this.assignNetIndex(this.s.local, 0);
      await publishLiveMatch({
        lobbyId: this.lobby.id, hostId: this.selfId,
        map: 'teahouse', mode: 'bomb',
        players: [{ id: this.selfId, name: this.profile.username, team: 0 }],
        allowSpec: true,
      });
      this._hb = setInterval(() => {
        heartbeatMatch(this.lobby.id, {
          round: this.s.match.round,
          score: { 0: this.s.match.score[0], 1: this.s.match.score[1] },
        }).catch(() => {});
      }, 8000);
    } else {
      // Clients hand their own simulation over: the host will send authority.
      this.predictor = new Predictor(this.s.app.player);
      this.s.botsEnabled = false;
      this.transport.announce();
    }
    this.connected = true;
  }

  assignNetIndex(player, idx) {
    player.netIndex = idx;
    this.roster.set(idx, player.id);
  }

  /* ------------------------------------------------------------------- host */

  /** Called from Session.update on the host. */
  hostTick(dt) {
    const now = performance.now();
    if (now - this.lastSnapshotAt < 1000 / SNAPSHOT_HZ) return;
    this.lastSnapshotAt = now;
    const buf = writeSnapshot(this.s.tick ?? 0, this.s.players, this.s.match);
    this.transport.broadcastState(buf);
  }

  /** A client has connected; give it the roster and the current round state. */
  onClientJoin(peerId) {
    // Reuse a slot if this user is reconnecting, otherwise take the next free one.
    let player = this.byUser.get(peerId);
    if (!player) {
      const idx = this.roster.size;
      player = this.s.addPlayer({
        id: `net:${peerId}`, name: `PLAYER ${idx}`, team: idx % 2, slot: idx,
        remote: true, userId: peerId, yaw: 0, pitch: 0, speed: 0,
      });
      this.assignNetIndex(player, idx);
      this.byUser.set(peerId, player);
      // A joining human replaces a bot rather than making the lobby eleven-strong.
      const bot = (this.s.bots ?? []).find((b) => !b.retired && b.p.team === player.team);
      if (bot) { bot.retired = true; bot.p.alive = false; bot.p.rig.group.visible = false; }
    }
    this.transport.sendTo(peerId, {
      t: 'welcome',
      netIndex: player.netIndex,
      roster: [...this.roster.entries()].map(([i, id]) => {
        const p = this.s.players.get(id);
        return { i, name: p?.name, team: p?.team, banner: p?.banner ?? null };
      }),
      map: 'teahouse',
      round: this.s.match.round,
    });
  }

  /**
   * A client reported a shot. The host re-traces it from the client's stated origin and
   * direction, so damage is always the host's own trace — the client only supplies aim.
   */
  hostResolveShot(peerId, msg) {
    const player = this.byUser.get(peerId);
    if (!player || !player.alive) return;
    const w = player.weapons?.[player.slot ?? 0];
    if (!w || w.empty) return;
    w.ammo--;

    const origin = new THREE.Vector3(msg.o[0], msg.o[1], msg.o[2]);
    const dir = new THREE.Vector3(msg.d[0], msg.d[1], msg.d[2]).normalize();

    // Reject a claimed origin that is nowhere near where the host thinks the player is.
    if (origin.distanceTo(player.position) > 2.5) return;

    const res = fireRound(this.s, origin, dir, w.def, player);
    for (const h of res.hits) {
      if (h.kind === 'surface') {
        if (h.piece) damageSurface(this.s, h.piece, h.point, (w.def.breachPower ?? 1) * 34);
      } else if (h.kind === 'player') {
        this.s.match.applyDamage(h.target, h.damage, player, h.zone);
      }
    }
    // Everyone needs to hear and see it.
    this.transport.broadcastEvent({ t: 'shot', i: player.netIndex, o: msg.o, d: msg.d });
    this.s.flashAt?.(origin, dir, w.def);
  }

  /* ----------------------------------------------------------------- client */

  /** Called from Session.update on a client. */
  clientTick(dt, cmd) {
    const now = performance.now();
    if (now - this.lastInputAt >= 1000 / 60) {
      this.lastInputAt = now;
      const seq = this.predictor.record(cmd);
      const buf = writeInput(seq, cmd, this.s.app.player);
      for (const link of this.transport.peers.values()) link.sendState(buf);
    }

    const snap = this.snapshots.sample();
    if (!snap) return;
    this.applySnapshot(snap, dt);
  }

  applySnapshot(snap, dt) {
    const m = this.s.match;
    // Round state is the host's to declare.
    m.round = snap.round;
    m.score[0] = snap.score[0];
    m.score[1] = snap.score[1];
    m.phaseTime = snap.timeLeft;
    const phase = { w: PHASE.WARMUP, p: PHASE.PREP, a: PHASE.ACTION, o: PHASE.MATCH_OVER, e: PHASE.ENDED }[snap.phaseChar];
    if (phase) m.phase = phase;

    for (const ps of snap.players) {
      const id = this.roster.get(ps.netIndex);
      const p = id ? this.s.players.get(id) : null;
      if (!p) continue;
      if (p.local) {
        p.health = ps.health;
        p.alive = ps.alive;
        p.dbno = ps.dbno;
        // Reconcile our own predicted position against the host's.
        this.predictor.reconcile({ x: ps.x, y: ps.y, z: ps.z, seq: this.ackSeq }, dt);
        continue;
      }
      p.position.set(ps.x, ps.y, ps.z);
      p.yaw = ps.yaw;
      p.pitch = ps.pitch;
      p.alive = ps.alive;
      p.dbno = ps.dbno;
      p.health = ps.health;
      p.aiming = ps.aiming;
      p.stance = ps.stance;
      // Speed is inferred from movement between snapshots so the gait animation works
      // without spending bandwidth on a field that is derivable.
      if (p._lastNetPos) {
        p.speed = p._lastNetPos.distanceTo(p.position) / Math.max(1e-3, 1 / SNAPSHOT_HZ);
      } else p._lastNetPos = new THREE.Vector3();
      p._lastNetPos.copy(p.position);
    }
  }

  /* ---------------------------------------------------------------- routing */

  onState(from, buf) {
    if (this.isHost) {
      const input = readInput(buf);
      if (!input) return;
      const player = this.byUser.get(from);
      if (!player) return;
      // Apply the client's authoritative-ish look and its own movement claim, then let
      // the host's own collision keep it honest.
      player.yaw = input.yaw;
      player.pitch = input.pitch;
      player.aiming = input.aim;
      player.stance = input.prone ? 2 : input.crouch ? 1 : 0;
      const claimed = new THREE.Vector3(input.px, input.py, input.pz);
      // Accept the client's position unless it moved impossibly far since the last one.
      const maxStep = 0.9;
      if (!player._netPrev || claimed.distanceTo(player._netPrev) < maxStep) {
        player.position.copy(claimed);
      }
      (player._netPrev ??= new THREE.Vector3()).copy(claimed);
      player.lastInputSeq = input.seq;
      if (input.fire) player.wantsFire = true;
    } else {
      const snap = readSnapshot(buf);
      if (snap) this.snapshots.push(snap);
    }
  }

  onEvent(from, msg) {
    switch (msg.t) {
      case 'hello':
        if (this.isHost) this.onClientJoin(from);
        break;
      case 'welcome': {
        // Client learns who it is and who everyone else is.
        this.roster.clear();
        for (const r of msg.roster) {
          if (r.i === msg.netIndex) { this.assignNetIndex(this.s.local, r.i); continue; }
          const p = this.s.addPlayer({
            id: `net:${r.i}`, name: r.name ?? `PLAYER ${r.i}`, team: r.team,
            slot: r.i, remote: true, banner: r.banner, yaw: 0, pitch: 0, speed: 0,
          });
          this.assignNetIndex(p, r.i);
        }
        this.s.local.netIndex = msg.netIndex;
        this.s.local.team = msg.roster.find((r) => r.i === msg.netIndex)?.team ?? 0;
        break;
      }
      case 'shot': {
        // Remote gunfire: play it where it happened rather than at the shooter's body,
        // so a shot through a window sounds like it came through the window.
        const o = new THREE.Vector3(...msg.o);
        const d = new THREE.Vector3(...msg.d);
        const id = this.roster.get(msg.i);
        const p = id ? this.s.players.get(id) : null;
        this.s.flashAt?.(o, d, p?.weapons?.[0]?.def);
        break;
      }
      case 'fire':
        if (this.isHost) this.hostResolveShot(from, msg);
        break;
      case 'event':
        this.s.match.emit(msg.name, msg.data ?? {});
        break;
      default:
        break;
    }
  }

  onPeerLeave(peerId) {
    const p = this.byUser.get(peerId);
    if (p) { p.alive = false; if (p.rig) p.rig.group.visible = false; }
    this.s.hud?.showBanner('PLAYER DISCONNECTED', '', 1800);
  }

  /** Clients call this instead of resolving their own shots. */
  reportShot(origin, dir) {
    this.transport.broadcastEvent({
      t: 'fire',
      o: [+origin.x.toFixed(3), +origin.y.toFixed(3), +origin.z.toFixed(3)],
      d: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)],
    });
  }

  /** Hosts mirror match events to everyone so killfeeds and banners stay in step. */
  mirrorEvent(name, data) {
    if (!this.isHost) return;
    this.transport.broadcastEvent({ t: 'event', name, data });
  }

  async dispose() {
    clearInterval(this._hb);
    if (this.isHost) await endLiveMatch(this.lobby.id).catch(() => {});
    this.transport.close();
    this.signal.close();
    this.connected = false;
  }
}
