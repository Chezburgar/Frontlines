/**
 * Spectator interface.
 *
 * Two halves: the operator chrome (match browser, camera controls, recording) and the
 * broadcast overlay (scoreboard, killfeed, nameplates). Every overlay piece toggles
 * independently, because what a caster wants on screen changes shot to shot — and H hides
 * the whole lot at once for a clean grab.
 */
import * as Net from '../src/net/supabase.js';
import { MODE } from './main.js';

const el = (tag, cls, parent, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};

export class SpectatorUI {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.visible = {
      scoreboard: true, killfeed: true, nameplates: true, timer: true, controls: true,
    };
    this.allHidden = false;
    this.kills = [];
    this._build();
  }

  _build() {
    this.gate = el('div', 'spec-gate', this.root);
    this.overlay = el('div', 'spec-overlay', this.root);

    // ---- top bar --------------------------------------------------------
    this.topbar = el('div', 'spec-top', this.overlay);
    this.scoreA = el('div', 'sc atk', this.topbar, '0');
    const mid = el('div', 'mid', this.topbar);
    this.timer = el('div', 'time', mid, '0:00');
    this.phase = el('div', 'ph', mid, '');
    this.scoreD = el('div', 'sc def', this.topbar, '0');

    // ---- killfeed -------------------------------------------------------
    this.killfeed = el('div', 'spec-killfeed', this.overlay);

    // ---- nameplates -----------------------------------------------------
    this.plates = el('div', 'spec-plates', this.overlay);

    // ---- roster / scoreboard -------------------------------------------
    this.roster = el('div', 'spec-roster', this.overlay);

    // ---- operator controls ---------------------------------------------
    this.controls = el('div', 'spec-controls', this.root);
    this._buildControls();

    this.flashNode = el('div', 'spec-flash', this.root);
    this.loading = el('div', 'spec-loading', this.root);
  }

  _buildControls() {
    const c = this.controls;
    el('h2', '', c, 'BROADCAST');

    const camRow = el('div', 'row', c);
    el('span', 'lbl', camRow, 'CAMERA');
    for (const [key, label] of [[MODE.FREE, 'FREE'], [MODE.FOLLOW, 'FOLLOW'], [MODE.EYES, 'EYES']]) {
      const b = el('button', 'cbtn', camRow, label);
      b.onclick = () => this.app.setMode(key);
      b.dataset.mode = key;
    }

    const tgtRow = el('div', 'row', c);
    el('span', 'lbl', tgtRow, 'TARGET');
    const prev = el('button', 'cbtn', tgtRow, '◄');
    this.targetName = el('span', 'tname', tgtRow, '—');
    const next = el('button', 'cbtn', tgtRow, '►');
    prev.onclick = () => this.app.cycleTarget(-1);
    next.onclick = () => this.app.cycleTarget(1);

    el('h3', '', c, 'OVERLAY');
    const toggles = el('div', 'toggles', c);
    for (const key of Object.keys(this.visible)) {
      const t = el('label', 'tg', toggles);
      const i = el('input', '', t);
      i.type = 'checkbox';
      i.checked = this.visible[key];
      i.onchange = () => { this.visible[key] = i.checked; this.applyVisibility(); };
      el('span', '', t, key.toUpperCase());
    }

    el('h3', '', c, 'RECORDING');
    const recRow = el('div', 'row', c);
    this.recBtn = el('button', 'cbtn rec', recRow, 'RECORD');
    this.recBtn.onclick = () => this.app.toggleRecording();
    this.recTime = el('span', 'rt', recRow, '');
    el('p', 'hint', c,
      'Recordings are written locally and downloaded as WebM. Nothing is uploaded.');

    el('p', 'hint keys', c,
      '1/2/3 camera · [ ] target · Ctrl+R record · H hide overlay · Scroll speed');
  }

  /* ------------------------------------------------------------------ gate */

  showLoading(label, p = 0) {
    this.loading.style.display = '';
    this.loading.innerHTML = '';
    el('div', 'lb', this.loading, 'FRONTLINES SPECTATOR');
    el('div', 'ls', this.loading, label);
    const bar = el('div', 'lbar', this.loading);
    el('i', '', bar).style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) this.loading.style.display = 'none';
  }

  hideLoading() { this.loading.style.display = 'none'; }

  showGate(message, offerSignIn) {
    this.hideLoading();
    this.gate.style.display = 'grid';
    this.gate.innerHTML = '';
    const card = el('div', 'gate-card', this.gate);
    el('h1', '', card, 'SPECTATOR');
    el('p', '', card, message);
    if (offerSignIn) {
      const form = el('div', 'gate-form', card);
      const email = el('input', '', form); email.type = 'email'; email.placeholder = 'Email';
      const pass = el('input', '', form); pass.type = 'password'; pass.placeholder = 'Password';
      const go = el('button', 'cbtn primary', form, 'SIGN IN');
      const err = el('p', 'err', card, '');
      go.onclick = async () => {
        go.disabled = true; go.textContent = 'CONNECTING…';
        try { await Net.signIn(email.value.trim(), pass.value); location.reload(); }
        catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'SIGN IN'; }
      };
    }
    el('p', 'dim', card, 'Access is granted per account from the game\'s admin panel.');
  }

  /* --------------------------------------------------------------- browser */

  async showBrowser() {
    this.hideLoading();
    this.gate.style.display = 'grid';
    this.gate.innerHTML = '';
    const card = el('div', 'gate-card wide', this.gate);
    el('h1', '', card, 'LIVE MATCHES');
    el('p', 'dim', card, `Signed in as ${this.app.profile.username}`);
    const list = el('div', 'match-list', card);

    const refresh = async () => {
      list.innerHTML = '';
      let matches = [];
      try { matches = await Net.listLiveMatches(); }
      catch (e) { el('p', 'err', list, e.message); return; }
      if (!matches.length) {
        el('p', 'dim', list, 'No matches are live right now. This refreshes automatically.');
        return;
      }
      for (const m of matches) {
        const row = el('button', 'match-row', list);
        el('span', 'mm', row, (m.map ?? 'teahouse').toUpperCase());
        el('span', 'ms', row, `ROUND ${m.round ?? 0}`);
        el('span', 'mp', row, `${(m.players ?? []).length} players`);
        el('span', 'mt', row, m.allow_spec ? 'OPEN' : 'CLOSED');
        row.disabled = !m.allow_spec;
        row.onclick = async () => {
          clearInterval(this._browserPoll);
          this.gate.style.display = 'none';
          await this.app.join(m.lobby_id, this.app.user.id);
          this.flash('CONNECTED');
        };
      }
    };
    await refresh();
    this._browserPoll = setInterval(refresh, 5000);
  }

  /* --------------------------------------------------------------- overlay */

  applyVisibility() {
    const v = this.visible;
    this.topbar.style.display = v.timer && !this.allHidden ? '' : 'none';
    this.killfeed.style.display = v.killfeed && !this.allHidden ? '' : 'none';
    this.plates.style.display = v.nameplates && !this.allHidden ? '' : 'none';
    this.roster.style.display = v.scoreboard && !this.allHidden ? '' : 'none';
    this.controls.style.display = v.controls && !this.allHidden ? '' : 'none';
  }

  toggleAll() {
    this.allHidden = !this.allHidden;
    this.applyVisibility();
  }

  flash(text) {
    this.flashNode.textContent = text;
    this.flashNode.classList.add('show');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.flashNode.classList.remove('show'), 1800);
  }

  onMatchEvent(name, data = {}) {
    if (name === 'player:killed') {
      const row = el('div', 'kf', this.killfeed);
      el('span', 'a', row, data.attackerName ?? 'WORLD');
      el('span', 'i', row, data.headshot ? '⌖' : '—');
      el('span', 'v', row, data.targetName ?? '');
      this.killfeed.prepend(row);
      while (this.killfeed.children.length > 6) this.killfeed.lastChild.remove();
      setTimeout(() => row.remove(), 7000);
    } else if (name === 'round:end') {
      this.flash('ROUND OVER');
    } else if (name === 'bomb:planted') {
      this.flash('CHARGE PLANTED');
    }
  }

  /* ------------------------------------------------------------------ tick */

  update(app) {
    const m = app.match;
    const t = Math.ceil(m.timeLeft ?? 0);
    this.timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.phase.textContent = m.phase ?? '';
    this.scoreA.textContent = m.score?.[0] ?? 0;
    this.scoreD.textContent = m.score?.[1] ?? 0;

    const tgt = app.target;
    this.targetName.textContent = tgt ? (tgt.name ?? `P${app.targetId}`) : '—';
    for (const b of this.controls.querySelectorAll('.cbtn[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === app.mode);
    }

    this.recBtn.classList.toggle('on', app.recording);
    this.recBtn.textContent = app.recording ? 'STOP' : 'RECORD';
    if (app.recording) {
      const s = Math.floor((performance.now() - app.recStart) / 1000);
      this.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    } else this.recTime.textContent = '';

    this.updatePlates(app);
    this.updateRoster(app);
  }

  /** World-space nameplates over each living player. */
  updatePlates(app) {
    if (!this.visible.nameplates || this.allHidden) return;
    const w = window.innerWidth, h = window.innerHeight;
    const v = new (app.camera.position.constructor)();
    // Reuse nodes; rebuilding the list each frame thrashes layout.
    while (this.plates.children.length < app.players.size) el('div', 'plate', this.plates);
    let i = 0;
    for (const [id, p] of app.players) {
      const node = this.plates.children[i++];
      const s = p.state;
      if (!s.alive || (app.mode === 'eyes' && id === app.targetId)) { node.style.display = 'none'; continue; }
      v.set(s.x, s.y + 2.0, s.z).project(app.camera);
      if (v.z > 1) { node.style.display = 'none'; continue; }
      node.style.display = '';
      node.className = `plate ${id % 2 ? 'def' : 'atk'}${id === app.targetId ? ' focus' : ''}`;
      node.textContent = `${p.name ?? `P${id}`}  ${Math.round(s.health)}`;
      node.style.transform =
        `translate(${Math.round((v.x * 0.5 + 0.5) * w)}px, ${Math.round((-v.y * 0.5 + 0.5) * h)}px)`;
    }
    for (; i < this.plates.children.length; i++) this.plates.children[i].style.display = 'none';
  }

  updateRoster(app) {
    if (!this.visible.scoreboard || this.allHidden) return;
    const sig = [...app.players.values()].map((p) => `${p.name}${p.state.alive ? 1 : 0}${p.state.health}`).join('|');
    if (sig === this._rosterSig) return;
    this._rosterSig = sig;
    this.roster.innerHTML = '';
    for (const side of [0, 1]) {
      const col = el('div', `rcol ${side ? 'def' : 'atk'}`, this.roster);
      for (const [id, p] of app.players) {
        if (id % 2 !== side) continue;
        const r = el('div', `rrow${p.state.alive ? '' : ' dead'}`, col);
        el('span', 'n', r, p.name ?? `P${id}`);
        el('span', 'hp', r, p.state.alive ? String(Math.round(p.state.health)) : '—');
      }
    }
  }
}
