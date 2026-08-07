/**
 * Input with rebindable controls.
 *
 * Actions are named, not keyed: every binding is a list of physical codes (`KeyW`,
 * `Mouse0`, `Wheel-`) mapped to an action, so rebinding is a data change and the game
 * logic never mentions a key. Bindings persist to localStorage and are round-tripped
 * through the account profile.
 *
 * Mouse look accumulates deltas between frames and is consumed once per tick, so look
 * sensitivity is frame-rate independent and no motion is dropped on a slow frame.
 */

export const DEFAULT_BINDINGS = {
  moveForward: ['KeyW'],
  moveBack: ['KeyS'],
  moveLeft: ['KeyA'],
  moveRight: ['KeyD'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  fire: ['Mouse0'],
  aim: ['Mouse1'],
  reload: ['KeyR'],
  interact: ['KeyF'],
  melee: ['KeyH'],
  nextWeapon: ['Wheel+'],
  prevWeapon: ['Wheel-'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  gadget1: ['Digit3'],
  gadget2: ['Digit4'],
  useGadget: ['KeyG'],
  buyMenu: ['KeyB'],
  drone: ['KeyT'],
  scoreboard: ['Tab'],
  ping: ['KeyX'],
  voice: ['KeyV'],
  menu: ['Escape'],
};

/** Human-readable labels for the settings screen. */
export const ACTION_LABELS = {
  moveForward: 'Move Forward', moveBack: 'Move Back', moveLeft: 'Move Left',
  moveRight: 'Move Right', jump: 'Jump', crouch: 'Crouch', prone: 'Prone',
  sprint: 'Sprint', leanLeft: 'Lean Left', leanRight: 'Lean Right',
  fire: 'Fire', aim: 'Aim Down Sights', reload: 'Reload', interact: 'Interact',
  melee: 'Melee', nextWeapon: 'Next Weapon', prevWeapon: 'Previous Weapon',
  weapon1: 'Primary', weapon2: 'Secondary', gadget1: 'Gadget 1', gadget2: 'Gadget 2',
  drone: 'Deploy Drone', scoreboard: 'Scoreboard', ping: 'Ping', voice: 'Push to Talk',
  menu: 'Menu',
};

const STORAGE_KEY = 'fl.input';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.settings = {
      sensitivity: 0.0022,
      adsSensitivity: 0.78,     // multiplier applied while aiming
      invertY: false,
      toggleCrouch: false,
      toggleAim: false,
      toggleSprint: false,
    };
    this.load();

    this.down = new Set();
    this.pressed = new Set();     // edge-triggered, cleared each tick
    this.released = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this._capture = null;         // rebinding callback

    this._toggles = { crouch: false, aim: false, sprint: false };

    this._bind();
  }

  /* -------------------------------------------------------------- storage */

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.bindings) {
        // Merge rather than replace so actions added in a later build keep a default.
        for (const [k, v] of Object.entries(saved.bindings)) {
          if (k in this.bindings && Array.isArray(v)) this.bindings[k] = v;
        }
      }
      if (saved.settings) Object.assign(this.settings, saved.settings);
    } catch { /* corrupt storage should never block startup */ }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        bindings: this.bindings, settings: this.settings,
      }));
    } catch { /* private mode */ }
  }

  resetBindings() {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.save();
  }

  /** Starts rebinding: the next physical input is assigned to `action`. */
  captureNext(action, slot = 0, onDone = null) {
    this._capture = { action, slot, onDone };
  }

  cancelCapture() { this._capture = null; }

  _applyCapture(code) {
    const { action, slot, onDone } = this._capture;
    this._capture = null;
    // A code may only drive one action; strip it from wherever it was.
    for (const [a, codes] of Object.entries(this.bindings)) {
      const i = codes.indexOf(code);
      if (i >= 0 && a !== action) codes.splice(i, 1);
    }
    const list = this.bindings[action] || (this.bindings[action] = []);
    list[slot] = code;
    this.save();
    onDone?.(code);
  }

  /* ---------------------------------------------------------------- events */

  _bind() {
    const kd = (e) => {
      if (this._capture && e.code !== 'Escape') { e.preventDefault(); this._applyCapture(e.code); return; }
      if (this._capture) { this.cancelCapture(); return; }
      if (!this.enabled) return;
      if (e.repeat) return;
      // Tab would move focus out of the canvas; Space/arrows scroll.
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    };
    const ku = (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    };
    const md = (e) => {
      const code = `Mouse${e.button}`;
      if (this._capture) { e.preventDefault(); this._applyCapture(code); return; }
      if (!this.enabled) return;
      this.down.add(code);
      this.pressed.add(code);
    };
    const mu = (e) => {
      const code = `Mouse${e.button}`;
      this.down.delete(code);
      this.released.add(code);
    };
    const mm = (e) => {
      if (!this.locked || !this.enabled) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    };
    const wh = (e) => {
      const code = e.deltaY > 0 ? 'Wheel+' : 'Wheel-';
      if (this._capture) { e.preventDefault(); this._applyCapture(code); return; }
      if (!this.enabled) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
      this.pressed.add(code);
    };
    const lockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.down.clear(); this.onUnlock?.(); }
    };
    const blur = () => { this.down.clear(); };

    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    document.addEventListener('mousemove', mm);
    this.canvas.addEventListener('wheel', wh, { passive: false });
    document.addEventListener('pointerlockchange', lockChange);
    window.addEventListener('blur', blur);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this._teardown = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      document.removeEventListener('mousemove', mm);
      this.canvas.removeEventListener('wheel', wh);
      document.removeEventListener('pointerlockchange', lockChange);
      window.removeEventListener('blur', blur);
    };
  }

  requestLock() { this.canvas.requestPointerLock?.(); }
  releaseLock() { if (this.locked) document.exitPointerLock?.(); }

  /* ---------------------------------------------------------------- query */

  isDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (c && this.down.has(c)) return true;
    return false;
  }

  wasPressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (c && this.pressed.has(c)) return true;
    return false;
  }

  /**
   * Builds this tick's command. Consuming look deltas here (rather than sampling them)
   * guarantees no mouse motion is lost between frames.
   */
  poll(adsBlend = 0) {
    const s = this.settings;
    const sens = s.sensitivity * (1 - adsBlend * (1 - s.adsSensitivity));
    const lookX = this.lookDX * sens;
    const lookY = this.lookDY * sens * (s.invertY ? -1 : 1);
    this.lookDX = 0; this.lookDY = 0;

    // Toggle-style options flip on press; hold-style read the raw state.
    if (s.toggleCrouch && this.wasPressed('crouch')) this._toggles.crouch = !this._toggles.crouch;
    if (s.toggleAim && this.wasPressed('aim')) this._toggles.aim = !this._toggles.aim;
    if (s.toggleSprint && this.wasPressed('sprint')) this._toggles.sprint = !this._toggles.sprint;

    const move = { x: 0, y: 0 };
    if (this.isDown('moveForward')) move.y += 1;
    if (this.isDown('moveBack')) move.y -= 1;
    if (this.isDown('moveRight')) move.x += 1;
    if (this.isDown('moveLeft')) move.x -= 1;

    const cmd = {
      move, lookX, lookY,
      jump: this.wasPressed('jump'),
      crouch: s.toggleCrouch ? this._toggles.crouch : this.isDown('crouch'),
      prone: this.isDown('prone'),
      sprint: s.toggleSprint ? this._toggles.sprint : this.isDown('sprint'),
      leanLeft: this.isDown('leanLeft'),
      leanRight: this.isDown('leanRight'),
      fire: this.isDown('fire'),
      firePressed: this.wasPressed('fire'),
      aim: s.toggleAim ? this._toggles.aim : this.isDown('aim'),
      reload: this.wasPressed('reload'),
      interact: this.wasPressed('interact'),
      interactHeld: this.isDown('interact'),
      melee: this.wasPressed('melee'),
      weaponSlot: this.wasPressed('weapon1') ? 0 : this.wasPressed('weapon2') ? 1 : -1,
      gadgetSlot: this.wasPressed('gadget1') ? 0 : this.wasPressed('gadget2') ? 1 : -1,
      useGadget: this.isDown('useGadget'),
      useGadgetPressed: this.wasPressed('useGadget'),
      buyMenu: this.wasPressed('buyMenu'),
      cycleWeapon: this.wheel,
      drone: this.wasPressed('drone'),
      scoreboard: this.isDown('scoreboard'),
      ping: this.wasPressed('ping'),
      voice: this.isDown('voice'),
      menu: this.wasPressed('menu'),
    };

    this.wheel = 0;
    this.pressed.clear();
    this.released.clear();
    return cmd;
  }

  /** Pretty name for a physical code, used by the bindings UI. */
  static label(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Mouse')) return ['Left Mouse', 'Middle Mouse', 'Right Mouse', 'Mouse 4', 'Mouse 5'][+code.slice(5)] ?? code;
    if (code === 'Wheel+') return 'Wheel Down';
    if (code === 'Wheel-') return 'Wheel Up';
    return code
      .replace('Control', 'Ctrl ')
      .replace('Left', ' L').replace('Right', ' R')
      .replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  dispose() { this._teardown?.(); }
}
