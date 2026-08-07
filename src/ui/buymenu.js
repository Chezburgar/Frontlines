/**
 * Prep-phase loadout menu.
 *
 * Open during preparation only. Attackers and defenders see different gadget lists, and
 * everything costs from a per-round budget so a loadout is a set of trade-offs rather than
 * a free pick-everything.
 *
 * Opening it releases the pointer lock and freezes the local player's input, which is what
 * makes it usable at all — the alternative is trying to click a menu while still walking.
 */
import { GADGETS, SIDE } from '../game/gadgets.js';
import { WEAPONS, ATTACHMENTS } from '../game/weapons.js';
import { SKINS } from './banner.js';
import { audio } from '../core/audio.js';

const el = (tag, cls, parent, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};

export const START_BUDGET = 1200;

export class BuyMenu {
  constructor(container, session) {
    this.s = session;
    this.root = el('div', 'buymenu', container);
    this.root.style.display = 'none';
    this.open = false;
    this.budget = START_BUDGET;
    this.selection = { gadgets: {}, primary: null, secondary: null };
    this.attach = { primary: null, secondary: null };
    this._onClose = null;
  }

  get side() { return this.s.match.sideOf[this.s.local.team]; }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.style.display = '';
    this.s.app.input.enabled = false;
    this.s.app.input.releaseLock();
    this.render();
    audio.ui('confirm');
  }

  close() {
    // Not guarded on `open`: this also serves as the recovery path if anything else left
    // input disabled, and re-enabling input must never be conditional.
    const wasOpen = this.open;
    this.open = false;
    this.root.style.display = 'none';
    this.s.app.input.enabled = true;
    if (!wasOpen) return;
    this.apply();
    this._onClose?.();
    audio.ui('tick');
  }

  /* ------------------------------------------------------------------ render */

  render() {
    this.root.innerHTML = '';
    const panel = el('div', 'buy-panel', this.root);

    const head = el('header', '', panel);
    el('h1', '', head, 'PREPARATION');
    const budget = el('div', 'budget', head, '');
    const timer = el('div', 'buy-timer', head, '');
    this._budgetNode = budget;
    this._timerNode = timer;

    el('p', 'hint', panel,
      this.side === SIDE.ATTACK
        ? 'Pick your approach. Drones and breaching tools open the building; the defence is already inside.'
        : 'Reinforce walls, cover angles and deny approaches. Look at a soft wall and press F to reinforce it.');

    const cols = el('div', 'buy-cols', panel);

    // ---- weapons ----------------------------------------------------------
    const wcol = el('div', 'buy-col', cols);
    el('h2', '', wcol, 'PRIMARY');
    this.weaponList(wcol, 0, 'primary');
    el('h2', '', wcol, 'SECONDARY');
    this.weaponList(wcol, 1, 'secondary');

    // ---- gadgets ----------------------------------------------------------
    const gcol = el('div', 'buy-col wide', cols);
    el('h2', '', gcol, 'GADGETS');
    const grid = el('div', 'gadget-grid', gcol);
    for (const [id, def] of Object.entries(GADGETS)) {
      if (def.side !== SIDE.BOTH && def.side !== this.side) continue;
      const owned = this.selection.gadgets[id] ?? 0;
      const card = el('button', `gadget-card${owned ? ' owned' : ''}`, grid);
      el('h3', '', card, def.name);
      el('p', '', card, def.desc);
      const foot = el('div', 'gfoot', card);
      el('span', 'cost', foot, def.cost ? `${def.cost}` : 'FREE');
      el('span', 'count', foot, owned ? `x${owned * def.count}` : '');
      card.onclick = () => {
        if (owned) {
          delete this.selection.gadgets[id];
          this.budget += def.cost;
        } else {
          if (this.budget < def.cost) { audio.ui('deny'); this.flashBudget(); return; }
          // Two gadget slots, like the genre — picking a third replaces the oldest.
          const keys = Object.keys(this.selection.gadgets);
          if (keys.length >= 2) {
            const drop = keys[0];
            this.budget += GADGETS[drop].cost;
            delete this.selection.gadgets[drop];
          }
          this.selection.gadgets[id] = 1;
          this.budget -= def.cost;
        }
        audio.ui('tick');
        this.render();
      };
    }

    const foot = el('footer', '', panel);
    const done = el('button', 'fl-btn primary big', foot, 'READY');
    done.onclick = () => this.close();
    el('span', 'dim', foot, 'B to reopen · Esc to close');

    this.refreshHeader();
  }

  weaponList(parent, slot, key) {
    const list = el('div', 'weapon-list', parent);
    const current = this.selection[key] ?? this.s.local.loadout?.[key]?.id;
    for (const [id, w] of Object.entries(WEAPONS)) {
      if (w.slot !== slot) continue;
      const row = el('button', `weapon-row${current === id ? ' on' : ''}`, list);
      el('span', 'wn', row, w.name);
      el('span', 'wc', row, w.class);
      el('span', 'wd', row, `${w.damage[0][1]} dmg · ${w.rpm} rpm`);
      row.onclick = () => {
        this.selection[key] = id;
        // Reset attachments when the weapon changes; the old ones may not fit.
        this.attach[key] = null;
        audio.ui('tick');
        this.render();
      };
    }

    // Attachments for whatever is selected, including optics — buying a scope has to be
    // possible here, not only from the out-of-match loadout screen.
    const wid = current;
    const w = WEAPONS[wid];
    if (!w?.attachments) return;
    const chosen = this.attachFor(key, wid);
    const grid = el('div', 'attach-grid compact', parent);
    for (const [cat, options] of Object.entries(w.attachments)) {
      if (options.length <= 1) continue;
      const row = el('label', 'field', grid);
      el('span', '', row, cat.toUpperCase());
      const sel = el('select', '', row);
      for (const optId of options) {
        const o = el('option', '', sel, ATTACHMENTS[cat][optId].name);
        o.value = optId;
        if (chosen[cat] === optId) o.selected = true;
      }
      sel.onchange = () => {
        chosen[cat] = sel.value;
        this.attach[key] = chosen;
        audio.ui('tick');
      };
    }
  }

  /** Current attachment choice for a slot, defaulting from the equipped loadout. */
  attachFor(key, weaponId) {
    if (this.attach[key]) return this.attach[key];
    const equipped = this.s.local.loadout?.[key];
    const base = equipped?.id === weaponId ? { ...equipped.attach } : defaultAttach(weaponId);
    this.attach[key] = base;
    return base;
  }

  flashBudget() {
    this._budgetNode?.classList.add('deny');
    setTimeout(() => this._budgetNode?.classList.remove('deny'), 400);
  }

  refreshHeader() {
    if (this._budgetNode) this._budgetNode.textContent = `${this.budget} CREDITS`;
    if (this._timerNode) this._timerNode.textContent = this.s.match.displayTime;
  }

  /** Called each frame while open so the prep clock stays live. */
  tick() {
    if (this.open) this.refreshHeader();
  }

  /* ------------------------------------------------------------------- apply */

  apply() {
    const local = this.s.local;
    // Weapons.
    const lo = JSON.parse(JSON.stringify(local.loadout));
    for (const key of ['primary', 'secondary']) {
      const id = this.selection[key] ?? lo[key].id;
      lo[key] = { id, attach: this.attach[key] ?? lo[key].attach ?? defaultAttach(id) };
    }
    this.s.equip(local, lo);

    // Gadgets.
    local.gadgets = Object.entries(this.selection.gadgets).map(([id]) => ({
      id, count: GADGETS[id].count, def: GADGETS[id],
    }));
    local.gadgetSlot = 0;
  }

  /** New round: refund and reset. */
  resetForRound() {
    this.budget = START_BUDGET;
    this.selection = { gadgets: {}, primary: null, secondary: null };
    this.attach = { primary: null, secondary: null };
    // A sensible default so a player who never opens the menu is not empty-handed.
    const defaults = this.side === SIDE.ATTACK ? ['frag', 'breach'] : ['barbed', 'nitro'];
    for (const id of defaults) {
      const def = GADGETS[id];
      if (def && this.budget >= def.cost) {
        this.selection.gadgets[id] = 1;
        this.budget -= def.cost;
      }
    }
    this.apply();
  }
}

function defaultAttach(weaponId) {
  const w = WEAPONS[weaponId];
  const pick = (cat) => (w.attachments?.[cat]?.[0] ?? 'none');
  return { sight: pick('sight'), barrel: pick('barrel'), grip: pick('grip'), under: pick('under') };
}
