/**
 * Match and round state machine.
 *
 * Round shape follows the genre: a prep phase where attackers scout with a drone and
 * defenders reinforce and place gadgets, then an action phase, then a plant that overrides
 * the round timer with a shorter fuse. Attackers win by eliminating the defence or letting
 * the charge detonate; defenders win by eliminating the attack, defusing, or running the
 * clock out.
 *
 * The state machine is deterministic and driven only by elapsed time and explicit events,
 * so the same code can run authoritatively on a host and be replayed by a spectator.
 */

export const PHASE = {
  WARMUP: 'warmup',
  PREP: 'prep',
  ACTION: 'action',
  PLANTED: 'planted',
  ENDED: 'ended',
  MATCH_OVER: 'over',
};

export const TEAM = { ATTACK: 0, DEFEND: 1 };

export const WIN = {
  ELIMINATION: 'elimination',
  DETONATION: 'detonation',
  DEFUSE: 'defuse',
  TIME: 'time',
  CARRIER_DOWN: 'carrier',
};

export const RULES = {
  prepSeconds: 30,
  actionSeconds: 165,
  fuseSeconds: 45,
  endSeconds: 6,
  roundsToWin: 4,          // first to 4, swap sides at 3
  swapAfter: 3,
  overtimeRounds: 2,
  plantSeconds: 4.0,
  defuseSeconds: 7.0,
  maxHealth: 100,
  dbnoHealth: 25,          // downed-but-not-out pool
  dbnoBleedSeconds: 45,
  reviveSeconds: 5.5,
};

export class Match {
  constructor(world, opts = {}) {
    this.world = world;
    this.rules = { ...RULES, ...opts.rules };
    this.phase = PHASE.WARMUP;
    this.phaseTime = 0;
    this.round = 0;
    this.score = { [TEAM.ATTACK]: 0, [TEAM.DEFEND]: 0 };
    // Which physical team is currently attacking; flips at the swap.
    this.sideOf = { 0: TEAM.ATTACK, 1: TEAM.DEFEND };
    this.site = null;
    this.bomb = { planted: false, defusing: false, planting: false, progress: 0, position: null, carrier: null };
    this.events = [];
    this.listeners = new Set();
    this.roundHistory = [];
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data = {}) {
    const ev = { type, t: performance.now() / 1000, round: this.round, ...data };
    this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  /* ------------------------------------------------------------- lifecycle */

  startMatch() {
    this.round = 0;
    this.score = { [TEAM.ATTACK]: 0, [TEAM.DEFEND]: 0 };
    this.emit('match:start');
    this.startRound();
  }

  startRound() {
    this.round++;
    this.phase = PHASE.PREP;
    this.phaseTime = this.rules.prepSeconds;
    this.bomb = { planted: false, defusing: false, planting: false, progress: 0, position: null, carrier: null };

    // Pick a site for this round and rotate through them across the match.
    const sites = this.world.map.objectives ?? [];
    this.site = sites.length ? sites[(this.round - 1) % sites.length] : null;

    // Side swap.
    if (this.round === this.rules.swapAfter + 1) {
      this.sideOf = { 0: this.sideOf[1], 1: this.sideOf[0] };
      this.emit('match:swap');
    }

    for (const p of this.world.players.values()) this.resetPlayerForRound(p);
    // The charge is on the ground from the moment preparation starts, so an attacker can
    // collect it while they are still setting up rather than racing for it at the buzzer.
    this.assignBomb();
    this.emit('round:start', { site: this.site?.id, phase: this.phase });
  }

  resetPlayerForRound(p) {
    p.alive = true;
    p.health = this.rules.maxHealth;
    p.dbno = false;
    p.dbnoTime = 0;
    p.kills = p.kills ?? 0;
    p.deaths = p.deaths ?? 0;
    p.hasBomb = false;
    const side = this.sideOf[p.team];
    const spawns = side === TEAM.ATTACK ? this.world.map.spawns.attack : this.world.map.spawns.defend;
    const group = spawns[(p.slot ?? 0) % spawns.length];
    const pt = group?.points[(p.slot ?? 0) % group.points.length];
    if (pt) {
      const yaw = Math.atan2(-pt.x, -pt.z);
      // Bots have no controller, so their transform has to be written directly — without
      // this every bot stays at the world origin and they all render inside each other.
      if (p.controller) p.controller.teleport(pt.x, pt.y + 0.1, pt.z, yaw);
      else { p.position.set(pt.x, pt.y, pt.z); p.yaw = yaw; p.speed = 0; }
    }
    p.spawnRoom = group?.name ?? '';
  }

  /**
   * Drops the charge at the attackers' spawn as a physical object.
   *
   * It is not silently handed to whoever happens to be first in the player list — one
   * attacker has to walk over and pick it up, and only that carrier can plant. Making it
   * a real object also means it can be dropped, seen and recovered when the carrier dies.
   */
  assignBomb() {
    const attackers = [...this.world.players.values()]
      .filter((p) => this.sideOf[p.team] === TEAM.ATTACK && p.alive);
    if (!attackers.length) return;

    // Spawn it at the middle of the attack spawn group, on the ground.
    const group = this.world.map.spawns.attack[0];
    const pt = group?.points?.[0] ?? { x: 0, y: 0, z: 24 };
    this.bomb.carrier = null;
    this.bomb.dropped = { x: pt.x, y: pt.y, z: pt.z };
    for (const p of attackers) p.hasBomb = false;
    this.emit('bomb:dropped', { position: [pt.x, pt.y, pt.z], atSpawn: true });

    // Bots never take the charge during preparation — that time belongs to the human
    // attackers. If it is still on the ground when the action phase begins, a random
    // living attacker (bot or human) is given it, so the round always has a carrier.
  }

  /** Hands the charge to a player standing on it. */
  pickUpBomb(player) {
    if (!this.bomb.dropped || this.bomb.carrier) return false;
    if (this.sideOf[player.team] !== TEAM.ATTACK || !player.alive) return false;
    this.bomb.dropped = null;
    this.bomb.carrier = player.id;
    player.hasBomb = true;
    this.emit('bomb:taken', { player: player.id, name: player.name });
    return true;
  }

  /** Hands the charge to a random living attacker. Used if prep ends unclaimed. */
  autoAssignBomb() {
    const attackers = [...this.world.players.values()]
      .filter((p) => this.sideOf[p.team] === TEAM.ATTACK && p.alive);
    if (!attackers.length) return;
    // A human standing near the charge when the buzzer goes clearly wanted it.
    const d = this.bomb.dropped;
    const near = d && attackers.find((p) => !p.bot
      && Math.hypot(p.position.x - d.x, p.position.z - d.z) < 6);
    const pick = near ?? attackers[Math.floor(Math.random() * attackers.length)];
    this.bomb.dropped = this.bomb.dropped ?? { x: 0, y: 0, z: 0 };
    this.bomb.carrier = null;
    this.pickUpBomb(pick);
  }

  /** Where the loose charge is, or null if someone is carrying it. */
  get looseBomb() { return this.bomb.planted ? null : this.bomb.dropped; }

  /* ------------------------------------------------------------------ tick */

  update(dt) {
    if (this.phase === PHASE.MATCH_OVER) return;
    this.phaseTime -= dt;

    if (this.phase === PHASE.PLANTED) this.updateDefuse(dt);
    else if (this.phase === PHASE.ACTION) this.updatePlant(dt);

    this.updateDbno(dt);

    if (this.phaseTime <= 0) this.advancePhase();
    else this.checkElimination();
  }

  advancePhase() {
    switch (this.phase) {
      case PHASE.PREP:
        this.phase = PHASE.ACTION;
        this.phaseTime = this.rules.actionSeconds;
        // Nobody volunteered during prep — give it to a random living attacker so the
        // round always has someone who can plant.
        if (!this.bomb.carrier) this.autoAssignBomb();
        this.emit('phase:action');
        break;
      case PHASE.ACTION:
        // Clock ran out with no plant: defenders hold.
        this.endRound(TEAM.DEFEND, WIN.TIME);
        break;
      case PHASE.PLANTED:
        this.endRound(TEAM.ATTACK, WIN.DETONATION);
        break;
      case PHASE.ENDED:
        this.nextRoundOrEnd();
        break;
      default:
        break;
    }
  }

  checkElimination() {
    if (this.phase !== PHASE.ACTION && this.phase !== PHASE.PLANTED) return;
    let atk = 0, def = 0;
    for (const p of this.world.players.values()) {
      if (!p.alive && !p.dbno) continue;
      if (this.sideOf[p.team] === TEAM.ATTACK) atk++; else def++;
    }
    if (atk === 0) {
      // Attackers wiped — but a live charge still wins it for them.
      if (this.phase !== PHASE.PLANTED) this.endRound(TEAM.DEFEND, WIN.ELIMINATION);
    } else if (def === 0) {
      this.endRound(TEAM.ATTACK, WIN.ELIMINATION);
    }
  }

  endRound(winningSide, reason) {
    if (this.phase === PHASE.ENDED || this.phase === PHASE.MATCH_OVER) return;
    this.phase = PHASE.ENDED;
    this.phaseTime = this.rules.endSeconds;

    // Credit the TEAM that was playing that side this round. Scoring by side meant that
    // after the swap a team's wins started accruing to their opponents' column.
    const winningTeam = this.sideOf[0] === winningSide ? 0 : 1;
    this.score[winningTeam]++;
    this.roundHistory.push({
      round: this.round, winner: winningSide, winningTeam, reason, site: this.site?.id,
    });
    this.emit('round:end', {
      winner: winningSide, winningTeam, reason, score: { ...this.score },
    });
  }

  nextRoundOrEnd() {
    const need = this.rules.roundsToWin;
    const a = this.score[0], d = this.score[1];
    if (a >= need || d >= need) {
      this.phase = PHASE.MATCH_OVER;
      this.emit('match:end', { winningTeam: a > d ? 0 : 1, score: { ...this.score } });
    } else {
      this.startRound();
    }
  }

  /* ------------------------------------------------------------------ bomb */

  /** Called each tick while an attacker holds the plant key inside the site. */
  tryPlant(player, dt, holding) {
    if (this.phase !== PHASE.ACTION || !player.hasBomb || !player.alive) return false;
    if (!holding || !this.inSite(player.controller.position)) {
      if (this.bomb.planting) { this.bomb.planting = false; this.bomb.progress = 0; this.emit('plant:cancel'); }
      return false;
    }
    if (!this.bomb.planting) { this.bomb.planting = true; this.emit('plant:begin', { player: player.id }); }
    this.bomb.progress += dt / this.rules.plantSeconds;
    if (this.bomb.progress >= 1) this.completePlant(player);
    return true;
  }

  updatePlant() { /* progress is driven by tryPlant from the input loop */ }

  completePlant(player) {
    this.bomb.planted = true;
    this.bomb.planting = false;
    this.bomb.progress = 0;
    this.bomb.position = player.controller.position.clone();
    this.bomb.carrier = player.id;
    player.hasBomb = false;
    this.phase = PHASE.PLANTED;
    this.phaseTime = this.rules.fuseSeconds;
    this.emit('bomb:planted', { player: player.id, position: this.bomb.position.toArray() });
  }

  tryDefuse(player, dt, holding) {
    if (this.phase !== PHASE.PLANTED || !player.alive) return false;
    if (this.sideOf[player.team] !== TEAM.DEFEND) return false;
    const near = this.bomb.position && player.controller.position.distanceTo(this.bomb.position) < 1.6;
    if (!holding || !near) {
      if (this.bomb.defusing) { this.bomb.defusing = false; this.bomb.progress = 0; this.emit('defuse:cancel'); }
      return false;
    }
    if (!this.bomb.defusing) { this.bomb.defusing = true; this.emit('defuse:begin', { player: player.id }); }
    this.bomb.progress += dt / this.rules.defuseSeconds;
    if (this.bomb.progress >= 1) {
      this.bomb.defusing = false;
      this.endRound(TEAM.DEFEND, WIN.DEFUSE);
    }
    return true;
  }

  updateDefuse() { /* progress is driven by tryDefuse from the input loop */ }

  inSite(pos) {
    if (!this.site) return false;
    for (const roomId of this.site.rooms) {
      const room = this.world.map.rooms.find((r) => r.id === roomId);
      if (!room) continue;
      const [x0, z0, x1, z1] = room.rect;
      if (pos.x >= x0 && pos.x <= x1 && pos.z >= z0 && pos.z <= z1
          && pos.y >= room.y - 0.5 && pos.y <= room.y + 3.4) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ dbno */

  updateDbno(dt) {
    for (const p of this.world.players.values()) {
      if (!p.dbno) continue;
      p.dbnoTime -= dt;
      p.health = Math.max(0, (p.dbnoTime / this.rules.dbnoBleedSeconds) * this.rules.dbnoHealth);
      if (p.dbnoTime <= 0) this.kill(p, p.lastAttacker, 'bleedout');
    }
  }

  /* ---------------------------------------------------------------- damage */

  applyDamage(target, amount, attacker, zone = 'body') {
    if (!target.alive || this.phase === PHASE.ENDED || this.phase === PHASE.MATCH_OVER) return null;
    // No friendly fire damage in casual rules, but the hit still registers as a warning.
    const friendly = attacker && attacker !== target && attacker.team === target.team;
    if (friendly) { this.emit('damage:friendly', { attacker: attacker.id, target: target.id }); return null; }

    target.health -= amount;
    target.lastAttacker = attacker ?? target.lastAttacker;
    attacker && (attacker.damageDealt = (attacker.damageDealt ?? 0) + amount);
    this.emit('damage', { target: target.id, attacker: attacker?.id, amount, zone, health: target.health });

    if (target.health <= 0) {
      // A teammate still standing means the player goes down rather than out.
      const mates = [...this.world.players.values()]
        .filter((p) => p !== target && p.team === target.team && p.alive && !p.dbno).length;
      if (mates > 0 && !target.dbno && zone !== 'head') {
        target.dbno = true;
        target.dbnoTime = this.rules.dbnoBleedSeconds;
        target.health = this.rules.dbnoHealth;
        this.emit('player:down', { target: target.id, attacker: attacker?.id, zone });
        return 'down';
      }
      this.kill(target, attacker, zone);
      return 'kill';
    }
    return 'hit';
  }

  kill(target, attacker, zone = 'body') {
    if (!target.alive) return;
    target.alive = false;
    target.dbno = false;
    target.health = 0;
    target.deaths = (target.deaths ?? 0) + 1;
    if (attacker && attacker !== target) attacker.kills = (attacker.kills ?? 0) + 1;
    this.emit('player:killed', {
      target: target.id, targetName: target.name, attacker: attacker?.id,
      attackerName: attacker?.name, zone, headshot: zone === 'head',
    });
    // Losing the carrier loses the round. The charge is the objective, not a relay baton,
    // so protecting whoever holds it is the attack's actual job.
    //
    // Keyed on the recorded carrier, not on the player's own hasBomb flag: a stale flag on
    // any other attacker would otherwise end the round the moment they died, while the
    // real carrier was still alive and holding it.
    const isCarrier = this.bomb.carrier != null && this.bomb.carrier === target.id;
    const inPlay = this.phase === PHASE.ACTION || this.phase === PHASE.PLANTED;
    if (isCarrier && inPlay && !this.bomb.planted) {
      target.hasBomb = false;
      this.bomb.carrier = null;
      this.emit('bomb:lost', { player: target.id, name: target.name });
      this.endRound(TEAM.DEFEND, WIN.CARRIER_DOWN);
      return;
    }
    this.checkElimination();
  }

  revive(target, medic) {
    if (!target.dbno) return false;
    target.dbno = false;
    target.health = 25;
    target.alive = true;
    this.emit('player:revived', { target: target.id, medic: medic?.id });
    return true;
  }

  /* ------------------------------------------------------------------ info */

  get timeLeft() { return Math.max(0, this.phaseTime); }

  get displayTime() {
    const t = Math.ceil(this.timeLeft);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  aliveCount(side) {
    let n = 0;
    for (const p of this.world.players.values()) {
      if ((p.alive || p.dbno) && this.sideOf[p.team] === side) n++;
    }
    return n;
  }
}
