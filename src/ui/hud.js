/**
 * In-match HUD.
 *
 * Built as DOM rather than drawn into the canvas: text stays crisp at any resolution, the
 * layout reflows for itself, and the spectator client can reuse the same elements with
 * individual pieces toggled off for a clean broadcast frame.
 *
 * Everything reads from state each frame but only writes to the DOM when a value actually
 * changes — a per-frame textContent assignment on a dozen nodes is a measurable cost.
 */
import { PHASE, TEAM, WIN } from '../game/match.js';

const el = (tag, cls, parent, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};

export class HUD {
  constructor(container) {
    this.root = el('div', 'hud', container);
    this._cache = new Map();
    this.visible = {
      crosshair: true, health: true, ammo: true, timer: true,
      killfeed: true, scoreboard: true, objective: true, compass: true,
    };
    this._build();
  }

  _build() {
    // ---- crosshair --------------------------------------------------------
    this.crosshair = el('div', 'xhair', this.root);
    for (const d of ['t', 'b', 'l', 'r']) el('i', `xh-${d}`, this.crosshair);
    this.xhairDot = el('u', 'xh-dot', this.crosshair);
    this.hitmarker = el('div', 'hitmark', this.root);
    for (const d of ['a', 'b', 'c', 'd']) el('i', `hm-${d}`, this.hitmarker);

    // ---- top bar ----------------------------------------------------------
    this.top = el('div', 'hud-top', this.root);
    this.scoreA = el('div', 'score atk', this.top, '0');
    const mid = el('div', 'timerwrap', this.top);
    this.timer = el('div', 'timer', mid, '0:00');
    this.phaseLabel = el('div', 'phase', mid, '');
    this.scoreD = el('div', 'score def', this.top, '0');

    this.aliveA = el('div', 'alive atk', this.top);
    this.aliveD = el('div', 'alive def', this.top);

    // ---- objective banner -------------------------------------------------
    this.objective = el('div', 'objective', this.root);

    // ---- bottom left: health ---------------------------------------------
    this.bl = el('div', 'hud-bl', this.root);
    this.healthBar = el('div', 'hpbar', this.bl);
    this.healthFill = el('i', '', this.healthBar);
    this.healthNum = el('div', 'hpnum', this.bl, '100');
    this.stanceIcon = el('div', 'stance', this.bl, 'STAND');

    // ---- bottom right: ammo ----------------------------------------------
    this.br = el('div', 'hud-br', this.root);
    this.ammoMag = el('span', 'mag', this.br, '30');
    this.ammoSep = el('span', 'sep', this.br, '/');
    this.ammoRes = el('span', 'res', this.br, '150');
    this.weaponName = el('div', 'wname', this.br, '');
    this.fireMode = el('div', 'fmode', this.br, '');

    // ---- killfeed ---------------------------------------------------------
    this.killfeed = el('div', 'killfeed', this.root);

    // ---- interaction prompt ----------------------------------------------
    this.prompt = el('div', 'prompt', this.root);

    // ---- progress ring (plant / defuse) ----------------------------------
    this.progress = el('div', 'progress', this.root);
    this.progressLabel = el('div', 'plabel', this.progress);
    this.progressBar = el('div', 'pbar', this.progress);
    this.progressFill = el('i', '', this.progressBar);

    // ---- scoreboard -------------------------------------------------------
    this.scoreboard = el('div', 'scoreboard', this.root);

    // ---- round banner -----------------------------------------------------
    this.banner = el('div', 'banner', this.root);
  }

  /** Writes only when the value changed. */
  _set(node, key, value) {
    if (this._cache.get(key) === value) return;
    this._cache.set(key, value);
    node.textContent = value;
  }

  _style(node, key, prop, value) {
    if (this._cache.get(key) === value) return;
    this._cache.set(key, value);
    node.style[prop] = value;
  }

  update(state) {
    const { match, player, weapon, coneDegrees, prompt, hit } = state;

    // ---- crosshair spread follows the actual cone of fire -----------------
    if (this.visible.crosshair) {
      const px = Math.max(2, Math.min(90, coneDegrees * 26));
      this.crosshair.style.setProperty('--gap', `${px.toFixed(1)}px`);
      this.crosshair.style.display = player?.ads > 0.85 && weapon?.def?.picked?.sight?.zoom > 2 ? 'none' : '';
    } else this.crosshair.style.display = 'none';

    // ---- hitmarker --------------------------------------------------------
    if (hit && hit.t > 0) {
      this.hitmarker.style.opacity = String(Math.min(1, hit.t * 4));
      this.hitmarker.classList.toggle('kill', !!hit.kill);
      this.hitmarker.classList.toggle('head', !!hit.head);
    } else this.hitmarker.style.opacity = '0';

    // ---- top bar ----------------------------------------------------------
    if (match) {
      this._set(this.timer, 'timer', match.displayTime);
      const label = match.phase === PHASE.PREP ? 'PREPARATION'
        : match.phase === PHASE.ACTION ? 'ACTION'
        : match.phase === PHASE.PLANTED ? 'CHARGE ACTIVE'
        : match.phase === PHASE.ENDED ? 'ROUND OVER' : '';
      this._set(this.phaseLabel, 'phase', label);
      this.timer.classList.toggle('urgent', match.timeLeft < 20 && match.phase !== PHASE.ENDED);
      this.timer.classList.toggle('planted', match.phase === PHASE.PLANTED);

      this._set(this.scoreA, 'sa', String(match.score[TEAM.ATTACK]));
      this._set(this.scoreD, 'sd', String(match.score[TEAM.DEFEND]));
      this._set(this.aliveA, 'aa', '●'.repeat(match.aliveCount(TEAM.ATTACK)));
      this._set(this.aliveD, 'ad', '●'.repeat(match.aliveCount(TEAM.DEFEND)));

      const objText = match.phase === PHASE.PLANTED ? 'DEFUSE THE CHARGE'
        : match.site ? `OBJECTIVE — ${match.site.name.toUpperCase()}` : '';
      this._set(this.objective, 'obj', this.visible.objective ? objText : '');
    }

    // ---- health -----------------------------------------------------------
    if (player && this.visible.health) {
      this.bl.style.display = '';
      const hp = Math.max(0, Math.round(player.health ?? 100));
      this._set(this.healthNum, 'hp', String(hp));
      this._style(this.healthFill, 'hpw', 'width', `${hp}%`);
      this.healthBar.classList.toggle('low', hp <= 35);
      this.healthBar.classList.toggle('dbno', !!player.dbno);
      this._set(this.stanceIcon, 'stance',
        player.stance === 2 ? 'PRONE' : player.stance === 1 ? 'CROUCH' : 'STAND');
    } else this.bl.style.display = 'none';

    // ---- ammo -------------------------------------------------------------
    if (weapon && this.visible.ammo) {
      this.br.style.display = '';
      this._set(this.ammoMag, 'mag', String(weapon.ammo));
      this._set(this.ammoRes, 'res', String(weapon.reserve));
      this._set(this.weaponName, 'wn', weapon.def.name.toUpperCase());
      this._set(this.fireMode, 'fm', weapon.def.semiAuto ? 'SEMI' : 'AUTO');
      this.ammoMag.classList.toggle('low', weapon.ammo <= Math.ceil(weapon.def.mag * 0.25));
      this.br.classList.toggle('reloading', weapon.reloading > 0);
    } else this.br.style.display = 'none';

    // ---- prompt -----------------------------------------------------------
    this._set(this.prompt, 'prompt', prompt ?? '');
    this.prompt.style.opacity = prompt ? '1' : '0';

    // ---- plant / defuse progress -----------------------------------------
    const bomb = match?.bomb;
    const active = bomb && (bomb.planting || bomb.defusing);
    this.progress.style.opacity = active ? '1' : '0';
    if (active) {
      this._set(this.progressLabel, 'plabel', bomb.planting ? 'PLANTING' : 'DEFUSING');
      this.progressFill.style.width = `${Math.min(100, bomb.progress * 100)}%`;
    }
  }

  /* ------------------------------------------------------------- killfeed */

  addKill({ attackerName, targetName, headshot, attackerTeam, weapon }) {
    if (!this.visible.killfeed) return;
    const row = el('div', 'kf-row', this.killfeed);
    el('span', `kf-name ${attackerTeam === TEAM.ATTACK ? 'atk' : 'def'}`, row, attackerName ?? 'WORLD');
    const icon = el('span', 'kf-icon', row, headshot ? '⌖' : '—');
    icon.title = weapon ?? '';
    el('span', 'kf-name victim', row, targetName ?? '');
    // Newest at the top, capped so a wipe does not push the feed off screen.
    this.killfeed.prepend(row);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild.remove();
    setTimeout(() => { row.classList.add('fade'); }, 5200);
    setTimeout(() => row.remove(), 6000);
  }

  showBanner(text, sub = '', ms = 3200) {
    this.banner.innerHTML = '';
    el('div', 'banner-main', this.banner, text);
    if (sub) el('div', 'banner-sub', this.banner, sub);
    this.banner.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  /* ----------------------------------------------------------- scoreboard */

  renderScoreboard(match, players, show) {
    this.scoreboard.classList.toggle('show', !!show && this.visible.scoreboard);
    if (!show) return;
    this.scoreboard.innerHTML = '';
    for (const side of [TEAM.ATTACK, TEAM.DEFEND]) {
      const col = el('div', `sb-col ${side === TEAM.ATTACK ? 'atk' : 'def'}`, this.scoreboard);
      el('div', 'sb-head', col, side === TEAM.ATTACK ? 'ATTACK' : 'DEFENCE');
      const rows = [...players].filter((p) => match.sideOf[p.team] === side)
        .sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0));
      for (const p of rows) {
        const r = el('div', `sb-row${p.alive ? '' : ' dead'}`, col);
        el('span', 'sb-name', r, p.name);
        el('span', 'sb-k', r, String(p.kills ?? 0));
        el('span', 'sb-d', r, String(p.deaths ?? 0));
        el('span', 'sb-dmg', r, String(Math.round(p.damageDealt ?? 0)));
      }
    }
  }

  setVisible(key, on) {
    this.visible[key] = on;
    if (key === 'killfeed') this.killfeed.style.display = on ? '' : 'none';
    if (key === 'timer') this.top.style.display = on ? '' : 'none';
  }

  destroy() { this.root.remove(); }
}
