/**
 * WebRTC transport.
 *
 * Topology is host-authoritative star, not a full mesh: at 10 players a mesh needs 45
 * connections and every client has to trust nine peers. A star needs 9, and only the host
 * resolves damage — which is also the only structure a spectator can join cheaply.
 *
 * Two channels per peer:
 *   - `state`  unreliable, unordered — snapshots and inputs, where a late packet is
 *              worse than a lost one,
 *   - `event`  reliable, ordered — joins, round transitions, chat, anything that must
 *              not be dropped.
 *
 * Signalling rides Supabase Realtime broadcast; ICE uses the metered TURN service so peers
 * behind symmetric NAT still connect.
 */

const TURN_API = 'https://frontlines.metered.live/api/v1/turn/credentials?apiKey=cfbe772df803ec4b0edff0c309c68885a34a';

let cachedIce = null;
let cachedAt = 0;

/**
 * Fetches TURN credentials. They are time-limited, so the result is cached for well under
 * their lifetime and re-fetched rather than reused indefinitely.
 */
export async function getIceServers() {
  const now = Date.now();
  if (cachedIce && now - cachedAt < 45 * 60 * 1000) return cachedIce;
  try {
    const res = await fetch(TURN_API);
    if (!res.ok) throw new Error(`TURN ${res.status}`);
    cachedIce = await res.json();
    cachedAt = now;
  } catch (err) {
    // A STUN-only fallback still connects most peers; without it we would fail closed.
    console.warn('[net] TURN fetch failed, falling back to STUN only:', err.message);
    cachedIce = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  return cachedIce;
}

const RTC_CONFIG_BASE = {
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

/** One connection to one peer. */
export class PeerLink {
  constructor(id, pc, { onState, onEvent, onClose, onVoice }) {
    this.id = id;
    this.pc = pc;
    this.state = null;
    this.event = null;
    this.onState = onState;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.onVoice = onVoice;
    this.rtt = 0;
    this.lastSeen = performance.now();
    this.connected = false;

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.connected = false;
        this.onClose?.(this.id, pc.connectionState);
      } else if (pc.connectionState === 'connected') {
        this.connected = true;
      }
    };
    pc.ontrack = (e) => this.onVoice?.(this.id, e.streams[0]);
  }

  attachChannel(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'state') {
      this.state = ch;
      ch.onmessage = (e) => { this.lastSeen = performance.now(); this.onState?.(this.id, e.data); };
    } else if (ch.label === 'event') {
      this.event = ch;
      ch.onmessage = (e) => {
        this.lastSeen = performance.now();
        try { this.onEvent?.(this.id, JSON.parse(e.data)); } catch { /* malformed peer data */ }
      };
    }
  }

  sendState(buf) {
    if (this.state?.readyState === 'open') {
      try { this.state.send(buf); } catch { /* buffer full; snapshot will be resent */ }
    }
  }

  sendEvent(obj) {
    if (this.event?.readyState === 'open') {
      try { this.event.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  close() {
    try { this.state?.close(); this.event?.close(); this.pc.close(); } catch { /* already gone */ }
  }
}

/**
 * Manages every peer connection for one lobby.
 * `signal` is a duplex channel supplied by the caller (see supabase.js) with
 * `send(to, payload)` and an `onMessage(from, payload)` hook.
 */
export class Transport {
  constructor({ selfId, isHost, signal, handlers = {} }) {
    this.selfId = selfId;
    this.isHost = isHost;
    this.signal = signal;
    this.peers = new Map();
    this.handlers = handlers;
    this.localStream = null;
    this.pendingCandidates = new Map();

    signal.onMessage = (from, msg) => this._onSignal(from, msg);
  }

  async _newPeer(id, initiator) {
    const ice = await getIceServers();
    const pc = new RTCPeerConnection({ ...RTC_CONFIG_BASE, iceServers: ice });

    const link = new PeerLink(id, pc, {
      onState: this.handlers.onState,
      onEvent: this.handlers.onEvent,
      onClose: (pid, why) => { this.peers.delete(pid); this.handlers.onPeerLeave?.(pid, why); },
      onVoice: this.handlers.onVoice,
    });
    this.peers.set(id, link);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal.send(id, { t: 'ice', c: e.candidate.toJSON() });
    };

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    if (initiator) {
      // Only the initiator creates channels; the other side receives them via ondatachannel.
      link.attachChannel(pc.createDataChannel('state', {
        ordered: false, maxRetransmits: 0,
      }));
      link.attachChannel(pc.createDataChannel('event', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal.send(id, { t: 'offer', sdp: offer.sdp });
    } else {
      pc.ondatachannel = (e) => link.attachChannel(e.channel);
    }
    return link;
  }

  async _onSignal(from, msg) {
    if (from === this.selfId) return;
    let link = this.peers.get(from);

    if (msg.t === 'offer') {
      if (!link) link = await this._newPeer(from, false);
      await link.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await this._flushCandidates(from, link);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.signal.send(from, { t: 'answer', sdp: answer.sdp });
    } else if (msg.t === 'answer') {
      if (!link) return;
      await link.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await this._flushCandidates(from, link);
    } else if (msg.t === 'ice') {
      // Candidates can arrive before the remote description is set; queue them.
      if (!link || !link.pc.remoteDescription) {
        const q = this.pendingCandidates.get(from) ?? [];
        q.push(msg.c);
        this.pendingCandidates.set(from, q);
        return;
      }
      try { await link.pc.addIceCandidate(msg.c); } catch { /* stale candidate */ }
    } else if (msg.t === 'hello' && this.isHost) {
      // A client announced itself; the host initiates so offer/answer never collide.
      if (!this.peers.has(from)) await this._newPeer(from, true);
    }
  }

  async _flushCandidates(from, link) {
    const q = this.pendingCandidates.get(from);
    if (!q) return;
    for (const c of q) { try { await link.pc.addIceCandidate(c); } catch { /* stale */ } }
    this.pendingCandidates.delete(from);
  }

  /** Clients call this once to ask the host to open a connection. */
  announce() { this.signal.send('*', { t: 'hello' }); }

  broadcastState(buf) { for (const p of this.peers.values()) p.sendState(buf); }
  broadcastEvent(obj) { for (const p of this.peers.values()) p.sendEvent(obj); }
  sendTo(id, obj) { this.peers.get(id)?.sendEvent(obj); }

  /** Adds a microphone track to every existing and future peer. */
  async attachVoice(stream) {
    this.localStream = stream;
    for (const link of this.peers.values()) {
      for (const track of stream.getTracks()) {
        const already = link.pc.getSenders().find((s) => s.track === track);
        if (!already) link.pc.addTrack(track, stream);
      }
    }
  }

  get peerCount() { return this.peers.size; }

  close() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }
}
