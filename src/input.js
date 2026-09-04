import { clamp, damp } from './util.js';

/**
 * キーボード / ゲームパッド / タッチをまとめて 1 つの入力に変換します。
 * アナログ（ゲームパッド）とデジタル（キー）を混ぜても破綻しないよう、
 * キー入力側は「じわっと立ち上がる」ように整形しています。
 */
export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = { throttle: 0, brake: 0, steer: 0, hb: 0, up: false, down: false };
    this.state = {
      throttle: 0, brake: 0, steer: 0, handbrake: 0,
      shiftUp: false, shiftDown: false, look: 0,
    };
    this._prevUp = false;
    this._prevDown = false;
    this.enabled = true;
    this.onAction = null;

    const down = (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
      this.keys.add(k);
      if (this.onAction) this.onAction(k);
    };
    const up = (e) => this.keys.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.keys.clear());
  }

  bindTouch(root) {
    const bind = (sel, on, off) => {
      const el = root.querySelector(sel);
      if (!el) return;
      const start = (e) => { e.preventDefault(); on(); el.classList.add('on'); };
      const end = (e) => { e.preventDefault(); off(); el.classList.remove('on'); };
      el.addEventListener('touchstart', start, { passive: false });
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
      el.addEventListener('mousedown', start);
      el.addEventListener('mouseup', end);
      el.addEventListener('mouseleave', end);
    };
    bind('#tc-acc', () => (this.touch.throttle = 1), () => (this.touch.throttle = 0));
    bind('#tc-brk', () => (this.touch.brake = 1), () => (this.touch.brake = 0));
    bind('#tc-left', () => (this.touch.steer = -1), () => (this.touch.steer = 0));
    bind('#tc-right', () => (this.touch.steer = 1), () => (this.touch.steer = 0));
    bind('#tc-up', () => (this.touch.up = true), () => (this.touch.up = false));
    bind('#tc-down', () => (this.touch.down = true), () => (this.touch.down = false));
  }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }

  sample(dt) {
    const s = this.state;
    const k = this.keys;
    let thr = this.touch.throttle;
    let brk = this.touch.brake;
    let str = this.touch.steer;
    let hb = this.touch.hb;
    let up = this.touch.up;
    let dn = this.touch.down;

    if (k.has('ArrowUp') || k.has('KeyW')) thr = 1;
    if (k.has('ArrowDown') || k.has('KeyS')) brk = 1;
    if (k.has('ArrowLeft') || k.has('KeyA')) str -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) str += 1;
    if (k.has('Space')) hb = 1;
    if (k.has('KeyE') || k.has('ShiftLeft') || k.has('ShiftRight')) up = true;
    if (k.has('KeyQ') || k.has('ControlLeft')) dn = true;

    // ゲームパッド（あれば優先的に上書き）
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.12) str = ax;
      const rt = p.buttons[7] ? p.buttons[7].value : 0;
      const lt = p.buttons[6] ? p.buttons[6].value : 0;
      if (rt > 0.02) thr = rt;
      if (lt > 0.02) brk = lt;
      if (p.buttons[0] && p.buttons[0].pressed) hb = 1;
      if (p.buttons[5] && p.buttons[5].pressed) up = true;
      if (p.buttons[4] && p.buttons[4].pressed) dn = true;
      break;
    }

    str = clamp(str, -1, 1);
    // キーの ON/OFF をなめらかに（ハンドルを一気に切らない）
    s.throttle = damp(s.throttle, thr, 16, dt);
    s.brake = damp(s.brake, brk, 20, dt);
    // 押した瞬間に効き、離すと素早くセンターへ戻る
    s.steer = damp(s.steer, str, str === 0 ? 20 : 16, dt);
    s.handbrake = hb;
    s.shiftUp = up && !this._prevUp;
    s.shiftDown = dn && !this._prevDown;
    this._prevUp = up;
    this._prevDown = dn;
    return s;
  }
}
