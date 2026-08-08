/**
 * Front-end shell: sign-in, main menu, matchmaking, lobbies, customization,
 * settings and the admin panel.
 *
 * One screen stack rather than a router — the shell is always mounted over the 3D view,
 * and screens push and pop. State lives in the shell and is written back to Supabase on
 * change, so a profile edit survives a reload without a save button.
 */
import * as Net from '../net/supabase.js';
import { DEFAULT_BANNER, PATTERNS, EMBLEMS, FRAMES, SKINS, drawBanner, bannerCanvas } from './banner.js';
import { Input, ACTION_LABELS } from '../core/input.js';
import { WEAPONS, ATTACHMENTS } from '../game/weapons.js';
import { audio } from '../core/audio.js';

const el = (tag, cls, parent, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};

const btn = (label, parent, cls = '', onClick) => {
  const b = el('button', `fl-btn ${cls}`, parent, label);
  b.addEventListener('click', (e) => { audio.ui('tick'); onClick?.(e); });
  return b;
};

export class Shell {
  constructor(container, app) {
    this.app = app;
    this.root = el('div', 'shell', container);
    this.user = null;
    this.profile = null;
    this.lobby = null;
    this.stack = [];
    this.onStartMatch = null;
    this._toastT = null;
  }

  /* ------------------------------------------------------------------ chrome */

  show() { this.root.style.display = ''; }
  hide() { this.root.style.display = 'none'; }

  clear() { this.root.innerHTML = ''; }

  toast(msg, kind = 'info') {
    let t = this.root.querySelector('.toast');
    if (!t) t = el('div', 'toast', this.root);
    t.className = `toast show ${kind}`;
    t.textContent = msg;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 3600);
  }

  /** Standard screen frame: title, optional back button, body container. */
  screen(title, { back = null, sub = '' } = {}) {
    this.clear();
    const wrap = el('div', 'screen', this.root);
    const head = el('header', 'screen-head', wrap);
    if (back) btn('◄  BACK', head, 'ghost small', back);
    const titles = el('div', 'titles', head);
    el('h1', '', titles, title);
    if (sub) el('p', 'sub', titles, sub);
    const body = el('div', 'screen-body', wrap);
    return body;
  }

  /* -------------------------------------------------------------------- auth */

  async start() {
    this.show();
    // Show the front page immediately rather than blocking on a network round trip —
    // a cold Supabase call can take a second, and staring at nothing is the worst
    // possible first impression.
    this.renderFront({ checking: true });

    let user = null;
    try { user = await Net.currentUser(); } catch { /* offline is fine */ }
    if (user) {
      this.user = user;
      try {
        this.profile = await Net.getProfile(user.id);
        const sanction = await Net.activeSanction(user.id);
        if (sanction) return this.renderBanned(sanction);
        return this.renderMenu();
      } catch (e) {
        console.warn('[shell] profile load failed', e);
      }
    }
    this.renderFront({ checking: false });
  }

  /**
   * Front page. The wordmark over the live map orbit, with the three things someone
   * landing here actually wants: play now, sign in, or read what this is.
   */
  renderFront({ checking = false } = {}) {
    this.clear();
    const wrap = el('div', 'front', this.root);

    const mark = el('div', 'wordmark', wrap);
    el('span', 'w1', mark, 'FRONT');
    el('span', 'w2', mark, 'LINES');
    el('div', 'tagline', wrap, 'Tactical 5v5 close-quarters combat');
    el('div', 'exclusive', wrap, 'A Chezburger Pro exclusive');

    const actions = el('div', 'front-actions', wrap);

    btn('ENTER', actions, 'primary big', () => {
      this.ensureProfile();
      this.renderMenu();
    });
    btn(checking ? 'CHECKING SESSION…' : 'SIGN IN', actions, 'big', () => {
      if (!checking) this.renderAuth('in');
    });
    btn('CREATE ACCOUNT', actions, 'ghost big', () => this.renderAuth('up'));

    const feats = el('div', 'front-feats', wrap);
    const feat = (t, d) => {
      const f = el('div', 'feat', feats);
      el('h3', '', f, t);
      el('p', '', f, d);
    };
    feat('TEAHOUSE', 'A walled Japanese estate around an open courtyard. Two storeys, sixteen rooms, breachable walls and paper screens that stop sight but not bullets.');
    feat('DESTRUCTION', 'Shoot through what you can, reinforce what you cannot. Every surface has a real penetration value that bullets spend as they pass through it.');
    feat('THE ROUND', 'Prep, breach, plant, hold. No respawns — one life, five operators, and whatever you brought with you.');

    el('div', 'front-foot', wrap, 'WASD move · Shift sprint · Ctrl crouch · Q/E lean · F interact · R reload');
  }

  renderAuth(mode = 'in') {
    const body = this.screen('ACCOUNT', {
      back: () => this.renderFront(), sub: 'Progress, cosmetics and online play',
    });
    const card = el('div', 'card auth', body);

    const tabs = el('div', 'tabs', card);
    const tIn = el('button', `tab ${mode === 'in' ? 'on' : ''}`, tabs, 'SIGN IN');
    const tUp = el('button', `tab ${mode === 'up' ? 'on' : ''}`, tabs, 'CREATE ACCOUNT');
    tIn.onclick = () => this.renderAuth('in');
    tUp.onclick = () => this.renderAuth('up');

    const form = el('div', 'form', card);
    const email = this.field(form, 'Email', 'email');
    const pass = this.field(form, 'Password', 'password');
    const user = mode === 'up' ? this.field(form, 'Callsign', 'text', { maxlength: 16 }) : null;

    const go = btn(mode === 'in' ? 'DEPLOY' : 'ENLIST', form, 'primary wide', async () => {
      go.disabled = true;
      go.textContent = 'CONNECTING…';
      try {
        if (mode === 'up') {
          if (!user.value || user.value.length < 3) throw new Error('Callsign must be 3-16 characters');
          await Net.signUp(email.value.trim(), pass.value, user.value.trim());
          this.toast('Account created. Check your email if confirmation is required.', 'good');
        } else {
          await Net.signIn(email.value.trim(), pass.value);
        }
        await this.start();
      } catch (err) {
        this.toast(err.message ?? String(err), 'bad');
        audio.ui('deny');
        go.disabled = false;
        go.textContent = mode === 'in' ? 'DEPLOY' : 'ENLIST';
      }
    });

    form.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

    // Offline play needs no account — useful for trying the game and for local testing.
    btn('PLAY OFFLINE vs BOTS', card, 'ghost wide', () => {
      this.profile = { username: 'OPERATOR', banner: DEFAULT_BANNER, level: 1, role: 'player', skins: {} };
      this.hide();
      this.onStartMatch?.({ offline: true, profile: this.profile });
    });
  }

  field(parent, label, type = 'text', attrs = {}) {
    const row = el('label', 'field', parent);
    el('span', '', row, label);
    const input = el('input', '', row);
    input.type = type;
    for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
    return input;
  }

  renderBanned(sanction) {
    const body = this.screen('ACCESS SUSPENDED');
    const card = el('div', 'card', body);
    el('p', 'big', card, sanction.kind === 'ban' ? 'Your account is banned.' : 'Your account is timed out.');
    el('p', '', card, `Reason: ${sanction.reason}`);
    if (sanction.expires_at) {
      el('p', 'dim', card, `Expires ${new Date(sanction.expires_at).toLocaleString()}`);
    } else {
      el('p', 'dim', card, 'This sanction does not expire.');
    }
    btn('SIGN OUT', card, 'ghost', async () => { await Net.signOut(); this.renderAuth(); });
  }

  /* -------------------------------------------------------------------- menu */

  /** A guest profile so every offline feature works without an account. */
  ensureProfile() {
    if (this.profile) return this.profile;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('fl.guest') || 'null'); } catch { /* corrupt */ }
    this.profile = saved ?? {
      username: 'OPERATOR', banner: { ...DEFAULT_BANNER }, level: 1,
      role: 'player', skins: {}, loadouts: {}, guest: true,
    };
    this.profile.guest = !this.user;
    return this.profile;
  }

  saveGuest() {
    if (!this.profile?.guest) return;
    try { localStorage.setItem('fl.guest', JSON.stringify(this.profile)); } catch { /* private mode */ }
  }

  /** Online features need a real account; offer the choice rather than hiding the button. */
  requireAccount(what) {
    if (this.user) return true;
    const body = this.screen('ACCOUNT REQUIRED', { back: () => this.renderMenu() });
    const card = el('div', 'card', body);
    el('p', 'big', card, `${what} needs an account.`);
    el('p', '', card, 'Matches with other people track stats and cosmetics against your profile, so they need somewhere to store them. Everything offline works without one.');
    btn('SIGN IN', card, 'primary wide', () => this.renderAuth('in'));
    btn('CREATE ACCOUNT', card, 'wide', () => this.renderAuth('up'));
    btn('BACK', card, 'ghost wide', () => this.renderMenu());
    return false;
  }

  renderMenu() {
    this.ensureProfile();
    const signedIn = !!this.user;
    const body = this.screen('FRONTLINES', {
      back: () => this.renderFront(),
      sub: signedIn ? `Signed in as ${this.profile.username}` : 'Playing as guest — sign in to play online',
    });
    const grid = el('div', 'menu-grid', body);

    const card = (title, desc, cls, onClick, lock = false) => {
      const c = el('button', `menu-card ${cls}${lock ? ' locked' : ''}`, grid);
      el('h2', '', c, title);
      el('p', '', c, desc);
      if (lock) el('span', 'lock-tag', c, 'ACCOUNT');
      c.addEventListener('click', () => { audio.ui('confirm'); onClick(); });
      return c;
    };

    card('QUICK MATCH', 'Find a 5v5 ranked match', 'primary', () => {
      if (this.requireAccount('Quick Match')) this.renderQueue();
    }, !signedIn);
    card('PRIVATE LOBBY', 'Create or join with a six-character code', '', () => {
      if (this.requireAccount('Private lobbies')) this.renderLobbyEntry();
    }, !signedIn);
    card('TRAINING', 'Teahouse against nine bots. No account needed.', '', () => {
      this.hide();
      this.onStartMatch?.({ offline: true, profile: this.profile });
    });
    card('TRAINING RANGE', 'Every weapon, optic and attachment free. Targets at 5 to 40 m with live hit readout.', '', () => {
      this.hide();
      this.onEnterRange?.(this.profile);
    });
    card('CUSTOMIZE', 'Banners, weapon skins and loadouts', '', () => this.renderCustomize());
    card('SETTINGS', 'Controls, video and audio', '', () => this.renderSettings());
    if (this.profile.role === 'admin' || this.profile.role === 'moderator') {
      card('ADMIN', 'Grant spectator access, ban and time out', 'admin', () => this.renderAdmin());
    }

    const foot = el('div', 'menu-foot', body);
    const st = this.profile.player_stats?.[0] ?? this.profile.player_stats ?? {};
    el('span', '', foot, `Level ${this.profile.level ?? 1}`);
    if (signedIn) {
      el('span', '', foot, `MMR ${st.mmr ?? 2500}`);
      el('span', '', foot, `K/D ${((st.kills ?? 0) / Math.max(1, st.deaths ?? 0)).toFixed(2)}`);
      btn('SIGN OUT', foot, 'ghost small', async () => {
        await Net.signOut(); this.user = null; this.profile = null; this.renderFront();
      });
    } else {
      btn('SIGN IN', foot, 'ghost small', () => this.renderAuth('in'));
    }

    // Banner preview, so the thing you customise is always in front of you.
    const bp = el('div', 'menu-banner', body);
    bp.appendChild(bannerCanvas(this.profile.banner ?? DEFAULT_BANNER, 380, 132, {
      label: this.profile.username, level: this.profile.level ?? 1,
    }));
  }

  /* ------------------------------------------------------------- matchmaking */

  async renderQueue() {
    const body = this.screen('MATCHMAKING', { back: () => this.cancelQueue() });
    const card = el('div', 'card queue', body);
    const status = el('p', 'big', card, 'Searching for a match…');
    const timer = el('div', 'qtimer', card, '0:00');
    el('p', 'dim', card, 'Search widens after 45 seconds so a match can start with fewer players.');
    btn('CANCEL', card, 'ghost', () => this.cancelQueue());

    this._queuing = true;
    try {
      const lobby = await Net.enterQueue({
        userId: this.user.id,
        mmr: this.profile.player_stats?.mmr ?? 2500,
        onTick: (s) => { timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },
      });
      if (!this._queuing) return;
      status.textContent = 'Match found';
      audio.ui('confirm');
      this.lobby = lobby;
      this.renderLobby(lobby);
    } catch (err) {
      if (this._queuing) this.toast(err.message ?? String(err), 'bad');
      this.renderMenu();
    }
  }

  async cancelQueue() {
    this._queuing = false;
    if (this.user) await Net.leaveQueue(this.user.id).catch(() => {});
    this.renderMenu();
  }

  /* ------------------------------------------------------------------ lobby */

  renderLobbyEntry() {
    const body = this.screen('PRIVATE LOBBY', { back: () => this.renderMenu() });
    const row = el('div', 'two-col', body);

    const left = el('div', 'card', row);
    el('h2', '', left, 'CREATE');
    el('p', 'dim', left, 'You host. Others join with the code you are given.');
    const name = this.field(left, 'Lobby name', 'text');
    name.value = `${this.profile.username}'s Lobby`;
    btn('CREATE LOBBY', left, 'primary wide', async () => {
      try {
        const lobby = await Net.createLobby({
          hostId: this.user.id, name: name.value || 'Private Lobby',
        });
        this.lobby = lobby;
        this.renderLobby(lobby);
      } catch (e) { this.toast(e.message, 'bad'); }
    });

    const right = el('div', 'card', row);
    el('h2', '', right, 'JOIN');
    el('p', 'dim', right, 'Enter the six-character code from the host.');
    const code = this.field(right, 'Lobby code', 'text', { maxlength: 6, style: 'text-transform:uppercase' });
    btn('JOIN LOBBY', right, 'primary wide', async () => {
      try {
        const lobby = await Net.joinLobbyByCode(code.value.trim(), this.user.id);
        this.lobby = lobby;
        this.renderLobby(lobby);
      } catch (e) { this.toast(e.message, 'bad'); audio.ui('deny'); }
    });
  }

  async renderLobby(lobby) {
    const isHost = lobby.host_id === this.user.id;
    const body = this.screen(lobby.name, {
      back: async () => {
        await Net.leaveLobby(lobby.id, this.user.id).catch(() => {});
        this.lobby = null;
        this.renderMenu();
      },
      sub: `Code ${lobby.code}`,
    });

    const teams = el('div', 'two-col teams', body);
    const cols = [el('div', 'card team atk', teams), el('div', 'card team def', teams)];
    el('h2', '', cols[0], 'ATTACK');
    el('h2', '', cols[1], 'DEFENCE');
    const lists = [el('div', 'roster', cols[0]), el('div', 'roster', cols[1])];

    const bar = el('div', 'lobby-bar', body);
    const count = el('span', '', bar, '');
    if (isHost) {
      btn('START MATCH', bar, 'primary', async () => {
        await Net.supabase.from('lobbies').update({ state: 'live' }).eq('id', lobby.id);
        this.hide();
        this.onStartMatch?.({ lobby, isHost: true, profile: this.profile, user: this.user });
      });
    } else {
      el('span', 'dim', bar, 'Waiting for the host to start…');
    }
    btn('SWAP TEAM', bar, 'ghost', async () => {
      const mine = (await Net.lobbyMembers(lobby.id)).find((m) => m.user_id === this.user.id);
      await Net.supabase.from('lobby_members')
        .update({ team: mine.team === 0 ? 1 : 0 })
        .eq('lobby_id', lobby.id).eq('user_id', this.user.id);
      refresh();
    });

    const refresh = async () => {
      const members = await Net.lobbyMembers(lobby.id);
      lists.forEach((l) => { l.innerHTML = ''; });
      for (const m of members) {
        const r = el('div', 'roster-row', lists[m.team] ?? lists[0]);
        const p = m.profiles ?? {};
        const c = bannerCanvas(p.banner ?? DEFAULT_BANNER, 64, 24);
        c.className = 'mini-banner';
        r.appendChild(c);
        el('span', 'rn', r, p.username ?? '…');
        if (m.is_host) el('span', 'tag', r, 'HOST');
      }
      count.textContent = `${members.length} / ${lobby.max_players}`;
    };
    await refresh();

    // Live roster updates while people join and swap.
    this._lobbyPoll = setInterval(refresh, 2500);
    this._lobbyWatch = Net.supabase.channel(`lobbystate:${lobby.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lobbies', filter: `id=eq.${lobby.id}` },
        ({ new: row }) => {
          if (row.state === 'live' && !isHost) {
            this.hide();
            this.onStartMatch?.({ lobby, isHost: false, profile: this.profile, user: this.user });
          }
        })
      .subscribe();
  }

  leaveLobbyWatchers() {
    clearInterval(this._lobbyPoll);
    if (this._lobbyWatch) Net.supabase.removeChannel(this._lobbyWatch);
  }

  /* -------------------------------------------------------------- customize */

  renderCustomize() {
    const body = this.screen('CUSTOMIZE', { back: () => this.renderMenu() });
    const tabs = el('div', 'tabs wide', body);
    const pane = el('div', 'pane', body);
    const mk = (label, fn) => {
      const t = el('button', 'tab', tabs, label);
      t.onclick = () => {
        [...tabs.children].forEach((c) => c.classList.remove('on'));
        t.classList.add('on');
        pane.innerHTML = '';
        fn(pane);
      };
      return t;
    };
    const first = mk('BANNER', (p) => this.paneBanner(p));
    mk('WEAPON SKINS', (p) => this.paneSkins(p));
    mk('LOADOUT', (p) => this.paneLoadout(p));
    first.click();
  }

  paneBanner(pane) {
    const b = { ...DEFAULT_BANNER, ...(this.profile.banner ?? {}) };
    const preview = el('div', 'banner-preview', pane);
    const canvas = document.createElement('canvas');
    canvas.width = 520; canvas.height = 180;
    preview.appendChild(canvas);
    const redraw = () => drawBanner(canvas, b, { label: this.profile.username, level: this.profile.level });
    redraw();

    const controls = el('div', 'controls', pane);
    const select = (label, options, key) => {
      const row = el('label', 'field', controls);
      el('span', '', row, label);
      const s = el('select', '', row);
      for (const [k, v] of Object.entries(options)) {
        const o = el('option', '', s, v);
        o.value = k;
        if (b[key] === k) o.selected = true;
      }
      s.onchange = () => { b[key] = s.value; redraw(); };
    };
    const colour = (label, key) => {
      const row = el('label', 'field', controls);
      el('span', '', row, label);
      const i = el('input', '', row);
      i.type = 'color';
      i.value = b[key];
      i.oninput = () => { b[key] = i.value; redraw(); };
    };

    select('Pattern', PATTERNS, 'pattern');
    colour('Primary', 'primary');
    colour('Secondary', 'secondary');
    select('Emblem', EMBLEMS, 'emblem');
    select('Frame', FRAMES, 'frame');

    btn('SAVE BANNER', controls, 'primary wide', async () => {
      this.profile.banner = b;
      if (this.user) {
        try { await Net.updateProfile(this.user.id, { banner: b }); this.toast('Banner saved', 'good'); }
        catch (e) { this.toast(e.message, 'bad'); }
      } else { this.saveGuest(); this.toast('Saved locally', 'good'); }
    });
  }

  paneSkins(pane) {
    const skins = { ...(this.profile.skins ?? {}) };
    el('p', 'dim', pane, 'Skins apply to the procedural weapon materials, so each one works on every weapon.');
    const grid = el('div', 'skin-grid', pane);
    for (const [wid, w] of Object.entries(WEAPONS)) {
      const card = el('div', 'skin-card', grid);
      el('h3', '', card, w.name);
      el('span', 'dim', card, w.class);
      const sel = el('select', '', card);
      for (const [sid, s] of Object.entries(SKINS)) {
        const o = el('option', '', sel, s.name);
        o.value = sid;
        if ((skins[wid] ?? 'default') === sid) o.selected = true;
      }
      const swatch = el('div', 'swatch', card);
      const paint = () => {
        const s = SKINS[sel.value];
        swatch.style.background = `linear-gradient(120deg, #${s.steel.toString(16).padStart(6, '0')} 0%, #${s.polymer.toString(16).padStart(6, '0')} 60%, #${s.accent.toString(16).padStart(6, '0')} 100%)`;
      };
      paint();
      sel.onchange = () => { skins[wid] = sel.value; paint(); };
    }
    btn('SAVE SKINS', pane, 'primary wide', async () => {
      this.profile.skins = skins;
      if (this.user) {
        try { await Net.updateProfile(this.user.id, { skins }); this.toast('Skins saved', 'good'); }
        catch (e) { this.toast(e.message, 'bad'); }
      } else { this.saveGuest(); this.toast('Saved locally', 'good'); }
    });
  }

  paneLoadout(pane) {
    const loadouts = { ...(this.profile.loadouts ?? {}) };
    const current = loadouts.default ?? {
      primary: { id: 'ar556', attach: { sight: 'holo', barrel: 'compensator', grip: 'vertical', under: 'none' } },
      secondary: { id: 'p9', attach: { sight: 'none', barrel: 'none', grip: 'none', under: 'none' } },
    };

    const build = (slotKey, filterSlot) => {
      const card = el('div', 'card', pane);
      el('h2', '', card, slotKey === 'primary' ? 'PRIMARY' : 'SECONDARY');
      const wsel = el('select', '', card);
      for (const [wid, w] of Object.entries(WEAPONS)) {
        if (w.slot !== filterSlot) continue;
        const o = el('option', '', wsel, `${w.name} — ${w.class}`);
        o.value = wid;
        if (current[slotKey].id === wid) o.selected = true;
      }
      const attachWrap = el('div', 'attach-grid', card);
      const renderAttach = () => {
        attachWrap.innerHTML = '';
        const w = WEAPONS[wsel.value];
        for (const [cat, options] of Object.entries(w.attachments ?? {})) {
          const row = el('label', 'field', attachWrap);
          el('span', '', row, cat.toUpperCase());
          const s = el('select', '', row);
          for (const key of options) {
            const o = el('option', '', s, ATTACHMENTS[cat][key].name);
            o.value = key;
            if (current[slotKey].attach?.[cat] === key) o.selected = true;
          }
          s.onchange = () => { current[slotKey].attach[cat] = s.value; };
        }
      };
      wsel.onchange = () => {
        current[slotKey].id = wsel.value;
        current[slotKey].attach = { sight: 'none', barrel: 'none', grip: 'none', under: 'none' };
        renderAttach();
      };
      renderAttach();
    };
    build('primary', 0);
    build('secondary', 1);

    btn('SAVE LOADOUT', pane, 'primary wide', async () => {
      loadouts.default = current;
      this.profile.loadouts = loadouts;
      if (this.user) {
        try { await Net.updateProfile(this.user.id, { loadouts }); this.toast('Loadout saved', 'good'); }
        catch (e) { this.toast(e.message, 'bad'); }
      } else { this.saveGuest(); this.toast('Saved locally', 'good'); }
    });
  }

  /* --------------------------------------------------------------- settings */

  renderSettings() {
    const body = this.screen('SETTINGS', { back: () => this.renderMenu() });
    const tabs = el('div', 'tabs wide', body);
    const pane = el('div', 'pane', body);
    const mk = (label, fn) => {
      const t = el('button', 'tab', tabs, label);
      t.onclick = () => {
        [...tabs.children].forEach((c) => c.classList.remove('on'));
        t.classList.add('on');
        pane.innerHTML = '';
        fn(pane);
      };
      return t;
    };
    const first = mk('CONTROLS', (p) => this.paneControls(p));
    mk('VIDEO', (p) => this.paneVideo(p));
    mk('AUDIO', (p) => this.paneAudio(p));
    first.click();
  }

  paneControls(pane) {
    const input = this.app.input;
    el('p', 'dim', pane, 'Click a binding then press any key or mouse button. Escape cancels.');
    const list = el('div', 'bind-list', pane);
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      const row = el('div', 'bind-row', list);
      el('span', '', row, label);
      const b = el('button', 'bind', row, Input.label(input.bindings[action]?.[0]));
      b.onclick = () => {
        b.textContent = 'PRESS ANY KEY';
        b.classList.add('listening');
        input.captureNext(action, 0, (code) => {
          b.textContent = Input.label(code);
          b.classList.remove('listening');
        });
      };
    }

    const s = input.settings;
    this.slider(pane, 'Mouse sensitivity', s.sensitivity * 1000, 0.4, 8, 0.05, (v) => {
      s.sensitivity = v / 1000; input.save();
    });
    this.slider(pane, 'ADS sensitivity multiplier', s.adsSensitivity, 0.2, 1.5, 0.01, (v) => {
      s.adsSensitivity = v; input.save();
    });
    this.toggle(pane, 'Invert vertical look', s.invertY, (v) => { s.invertY = v; input.save(); });
    this.toggle(pane, 'Hold to crouch', !s.toggleCrouch, (v) => { s.toggleCrouch = !v; input.save(); });
    this.toggle(pane, 'Hold to aim', !s.toggleAim, (v) => { s.toggleAim = !v; input.save(); });
    btn('RESET TO DEFAULTS', pane, 'ghost', () => { input.resetBindings(); this.paneControls(pane); });
  }

  paneVideo(pane) {
    const r = this.app.renderer;
    const row = el('label', 'field', pane);
    el('span', '', row, 'Quality preset');
    const sel = el('select', '', row);
    for (const key of ['low', 'medium', 'high', 'ultra']) {
      const o = el('option', '', sel, key.toUpperCase());
      o.value = key;
      if (r.qualityName === key) o.selected = true;
    }
    sel.onchange = () => {
      r.setQuality(sel.value);
      this.app.quality = sel.value;
      localStorage.setItem('fl.quality', sel.value);
    };

    const g = r.grade;
    this.slider(pane, 'Exposure', g.exposure, 0.4, 1.6, 0.01, (v) => { g.exposure = v; });
    this.slider(pane, 'Bloom', g.bloom, 0, 0.2, 0.005, (v) => { g.bloom = v; });
    this.slider(pane, 'Saturation', g.saturation, 0.6, 1.5, 0.01, (v) => { g.saturation = v; });
    this.slider(pane, 'Vignette', g.vignette, 0, 0.8, 0.01, (v) => { g.vignette = v; });
    this.slider(pane, 'Field of view', this.app.camera.fov, 60, 105, 1, (v) => {
      this.app.camera.fov = v; this.app.camera.updateProjectionMatrix();
    });
  }

  paneAudio(pane) {
    this.slider(pane, 'Master volume', audio.volumes.master, 0, 1, 0.01, (v) => audio.setVolume('master', v));
    this.slider(pane, 'Effects', audio.volumes.sfx, 0, 1, 0.01, (v) => audio.setVolume('sfx', v));
    this.slider(pane, 'Voice chat', audio.volumes.voice, 0, 1, 0.01, (v) => audio.setVolume('voice', v));
    this.toggle(pane, 'Proximity voice chat', true, (v) => { this.app.voiceEnabled = v; });
    el('p', 'dim', pane, 'Proximity voice fades with distance and is muffled through walls, the same way gunfire is.');
  }

  slider(parent, label, value, min, max, step, onInput) {
    const row = el('label', 'field slider', parent);
    el('span', '', row, label);
    const i = el('input', '', row);
    i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
    const out = el('b', '', row, (+value).toFixed(2));
    i.oninput = () => { out.textContent = (+i.value).toFixed(2); onInput(+i.value); };
    return i;
  }

  toggle(parent, label, value, onChange) {
    const row = el('label', 'field toggle', parent);
    el('span', '', row, label);
    const i = el('input', '', row);
    i.type = 'checkbox';
    i.checked = !!value;
    i.onchange = () => onChange(i.checked);
    return i;
  }

  /* ------------------------------------------------------------------ admin */

  async renderAdmin() {
    const body = this.screen('ADMIN', { back: () => this.renderMenu(), sub: 'Spectator access and moderation' });
    const search = this.field(body, 'Search callsign', 'text');
    const list = el('div', 'admin-list', body);

    const refresh = async () => {
      list.innerHTML = '';
      let users = [];
      try { users = await Net.adminListUsers(search.value.trim()); }
      catch (e) { this.toast(e.message, 'bad'); return; }
      for (const u of users) {
        const row = el('div', 'admin-row', list);
        el('span', 'rn', row, u.username);
        el('span', `role ${u.role}`, row, u.role.toUpperCase());
        if (u.spectator) el('span', 'tag spec', row, 'SPECTATOR');

        const specBtn = el('button', 'fl-btn small', row, u.spectator ? 'REVOKE SPEC' : 'GRANT SPEC');
        specBtn.onclick = async () => {
          try {
            await Net.adminSetSpectator(u.id, !u.spectator);
            this.toast(`${u.username}: spectator ${!u.spectator ? 'granted' : 'revoked'}`, 'good');
            refresh();
          } catch (e) { this.toast(e.message, 'bad'); }
        };

        const toBtn = el('button', 'fl-btn small warn', row, 'TIMEOUT');
        toBtn.onclick = async () => {
          const mins = +prompt(`Timeout ${u.username} for how many minutes?`, '60');
          if (!mins) return;
          const reason = prompt('Reason?', 'Disruptive behaviour') || 'Unspecified';
          try {
            await Net.adminSanction({ userId: u.id, kind: 'timeout', reason, minutes: mins, issuedBy: this.user.id });
            this.toast(`${u.username} timed out for ${mins} minutes`, 'good');
          } catch (e) { this.toast(e.message, 'bad'); }
        };

        const banBtn = el('button', 'fl-btn small bad', row, 'BAN');
        banBtn.onclick = async () => {
          const reason = prompt(`Ban ${u.username}. Reason?`, 'Cheating');
          if (!reason) return;
          try {
            await Net.adminSanction({ userId: u.id, kind: 'ban', reason, issuedBy: this.user.id });
            this.toast(`${u.username} banned`, 'good');
          } catch (e) { this.toast(e.message, 'bad'); }
        };

        const liftBtn = el('button', 'fl-btn small ghost', row, 'LIFT');
        liftBtn.onclick = async () => {
          try { await Net.adminLiftSanctions(u.id); this.toast(`Sanctions lifted for ${u.username}`, 'good'); }
          catch (e) { this.toast(e.message, 'bad'); }
        };
      }
    };
    search.oninput = () => { clearTimeout(this._adminT); this._adminT = setTimeout(refresh, 260); };
    await refresh();
  }
}
