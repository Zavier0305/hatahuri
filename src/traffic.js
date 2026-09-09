import * as THREE from 'three';
import { rng, clamp, lerp } from './util.js';
import { LANE_U, ONCOMING_U } from './track.js';
import { buildTrafficCar } from './carModel.js';

const COLORS = [0xd8dade, 0x1b1d22, 0x5a6068, 0x2a3a5a, 0x8f9298, 0x30425c, 0xbfc3c8, 0x6b3f2a];

/**
 * 一般車の管理。プレイヤーの前後 1.2km ぶんだけ実体を持ち、
 * 通り過ぎたら前方へ「使い回し」ます（オブジェクトプール）。
 */
export class Traffic {
  constructor(track, scene, count = 44, seed = 4242) {   // seed はコースごとに変えます
    this.track = track;
    this.rand = rng(seed);
    this.cars = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.density = 1;

    for (let i = 0; i < count; i++) {
      const roll = this.rand();
      const kind = roll < 0.16 ? 'truck' : roll < 0.30 ? 'van' : 'sedan';
      const model = buildTrafficCar(kind, COLORS[(this.rand() * COLORS.length) | 0], this.rand);
      this.group.add(model.root);
      this.cars.push({
        model, kind,
        s: 0, u: 0, vx: 0, lane: 0, oncoming: false, active: false,
        // 一般道に出られる個体。片側1車線なので、本線と同じ数を出すと
        // 20mおきに詰まった渋滞になります。4台に1台だけ出します。
        surfSlot: i % 4 === 0,
        surface: false, laneOff: 0, surfH: 0,
        laneChange: 0, targetU: 0,
        // 衝突の計算に使う実寸と質量（大型トラックに突っ込めば、当然こちらが弾かれます）
        halfW: model.width * 0.5, halfL: model.length * 0.5, cruise: 0,
        mass: kind === 'truck' ? 13000 : kind === 'van' ? 2100 : 1450,
        nudge: 0,
      });
    }
    this._tmp = {};
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._fwd = new THREE.Vector3();
    this._lft = new THREE.Vector3();
    this._near = [];
    this._nearPool = [];
  }

  /**
   * プレイヤーの周囲に配置しなおします。
   * surface を渡すと、本線ではなく一般道（側道）へ出します。
   */
  respawn(car, playerS, ahead, surface = false) {
    const r = this.rand;
    const oncoming = r() < (surface ? 0.5 : 0.34);
    car.oncoming = oncoming;
    car.surface = surface;
    if (surface) {
      // 一般道は片側1車線。中心から半車線ぶん寄せた位置を走ります
      car.lane = 0;
      // 日本の道なので左側通行。lat は「進行方向に対して右」なので、
      // 自分と同じ向きの車は中心より負（＝左）へ寄せます。
      car.laneOff = (oncoming ? 1 : -1) * 1.7;
      car.u = 0;                       // 実際の横位置は update で毎回求めます
      car.targetU = 0;
      const base = car.kind === 'truck' ? 42 : car.kind === 'van' ? 48 : 52;
      car.cruise = (base + r() * 14) / 3.6;
      car.vx = car.cruise;
      car.s = playerS + (ahead ? 90 + Math.pow(r(), 1.3) * 420 : -(70 + r() * 200));
      car.active = true;
      car.laneChange = 999;            // 一般道では車線変更しません
      return;
    }
    car.laneOff = 0;
    const lanes = oncoming ? ONCOMING_U : LANE_U;
    let lane;
    if (car.kind === 'truck') lane = lanes.length - 1;                 // 大型は左寄り
    else lane = Math.min(lanes.length - 1, Math.floor(Math.pow(r(), 1.5) * lanes.length) + (oncoming ? 0 : 1));
    car.lane = clamp(lane, 0, lanes.length - 1);
    car.u = lanes[car.lane];
    car.targetU = car.u;
    const base = car.kind === 'truck' ? 78 : car.kind === 'van' ? 88 : 95;
    car.cruise = (base + r() * 26 - car.lane * 9) / 3.6;
    car.vx = car.cruise;
    // 前方に厚めに、後方にも少し。以前は最大1.1km先まで散らしていたため、
    // 高速で走ると「誰もいない道」に見えていました。
    const dist = 120 + Math.pow(r(), 1.4) * 620;
    car.s = playerS + (ahead ? dist : -(90 + r() * 260));
    car.active = true;
    car.laneChange = 2 + r() * 12;
  }

  /**
   * @param onSurface 自車が一般道にいるか。いるなら一般車もそちらへ出します。
   *                  高速の車を一般道から見上げても意味がないので、
   *                  自車のいる側だけに実体を置きます。
   */
  update(dt, playerS, playerU, onSurface = false) {
    const L = this.track.length;
    const surfOK = onSurface && !!this.track.surfaceAt;
    for (const c of this.cars) {
      if (surfOK && !c.surfSlot) {
        if (c.active) { c.active = false; c.model.root.visible = false; }
        continue;
      }
      if (!c.active) { this.respawn(c, playerS, true, surfOK); c.model.root.visible = true; continue; }
      // 自車が高速と一般道を行き来したら、一般車も入れ替えます
      if (!!c.surface !== surfOK) { this.respawn(c, playerS, this.rand() < 0.6, surfOK); continue; }
      c.s += (c.oncoming ? -c.vx : c.vx) * dt;

      // 車線変更（たまに）。一般道は1車線なのでしません
      c.laneChange -= dt;
      if (c.laneChange <= 0 && c.kind !== 'truck') {
        const lanes = c.oncoming ? ONCOMING_U : LANE_U;
        if (this.rand() < 0.35) {
          // 追越車線（lane 0）には一般車を出さない。
          // プレイヤーが全開で走る車線を塞がないための、意図的なルールです。
          const lo = c.oncoming ? 0 : 1;
          const nl = clamp(c.lane + (this.rand() < 0.5 ? -1 : 1), lo, lanes.length - 1);
          c.lane = nl;
          c.targetU = lanes[nl];
        }
        c.laneChange = 6 + this.rand() * 16;
      }
      if (c.surface) {
        // 一般道の横位置は、その地点の道の中心から決めます
        const sf = this.track.surfaceAt(c.s);
        if (!sf) { this.respawn(c, playerS, true, true); continue; }
        c.u = sf.u + c.laneOff;
        c.surfH = sf.h;
      } else {
        c.u = lerp(c.u, c.targetU, 1 - Math.exp(-dt * 0.9));
      }
      // 押し出された速度は、じわっと本来の巡航速度へ戻します
      if (c.cruise && Math.abs(c.vx - c.cruise) > 0.05) {
        c.vx = lerp(c.vx, c.cruise, 1 - Math.exp(-dt * 0.55));
      }
      // ぶつけられた直後は少しふらつく
      if (c.nudge > 0) {
        c.nudge = Math.max(0, c.nudge - dt);
        c.u += Math.sin(c.nudge * 22) * c.nudge * 0.35;
      }

      // 相対距離で再配置
      let rel = c.s - playerS;
      if (rel > L / 2) rel -= L;
      if (rel < -L / 2) rel += L;
      if (rel < -300 || rel > 900) this.respawn(c, playerS, rel < 0, surfOK);

      // 見た目の更新
      const sm = this.track.sample(c.s, this._tmp);
      const root = c.model.root;
      root.position.copy(sm.pos).addScaledVector(sm.lat, c.u)
        .addScaledVector(sm.up, (c.surface ? c.surfH : 0) + 0.01);
      // 右手系（X×Y=Z）になるよう、+X は「進行方向の左」を取ります
      const fwd = c.oncoming ? this._fwd.copy(sm.tan).negate() : this._fwd.copy(sm.tan);
      const lft = c.oncoming ? this._lft.copy(sm.lat) : this._lft.copy(sm.lat).negate();
      this._m.makeBasis(lft, sm.up, fwd);
      this._q.setFromRotationMatrix(this._m);
      root.quaternion.copy(this._q);
      const spin = (c.vx / 0.32) * dt;
      for (const w of c.model.wheels) w.rotation.x -= spin;
      root.visible = Math.abs(rel) < 1200;
    }
  }

  /** 当たり判定用に、指定範囲の車を返します。 */
  near(s, range = 90) {
    const L = this.track.length;
    const out = this._near;
    out.length = 0;
    let k = 0;
    for (const c of this.cars) {
      if (!c.active) continue;
      let rel = c.s - s;
      if (rel > L / 2) rel -= L;
      if (rel < -L / 2) rel += L;
      if (Math.abs(rel) >= range) continue;
      let e = this._nearPool[k];
      if (!e) e = this._nearPool[k] = { car: null, rel: 0 };
      e.car = c; e.rel = rel;
      out.push(e);
      k++;
    }
    return out;
  }
}
