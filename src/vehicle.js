import * as THREE from 'three';
import { clamp, lerp, damp, RADS_TO_RPM, KMH } from './util.js';

const G = 9.81;
const RHO = 1.225;      // 空気密度[kg/m^3]
const DRIVE_EFF = 0.90; // 駆動系の伝達効率

/** レイアウトごとの前後重量配分（前輪側の比率） */
const WEIGHT_BIAS = { FR: 0.54, RR: 0.39, MR: 0.42, AWD: 0.56 };
/** 駆動トルクの前輪への配分 */
const DRIVE_SPLIT = { FR: 0, RR: 0, MR: 0, AWD: 0.38 };

/** チューニング段階（0〜5）から実効スペックを計算します。 */
export function applyTune(spec, tune) {
  const t = tune || { power: 0, weight: 0, tire: 0, aero: 0, gear: 0, turbo: 0 };
  const power = spec.power * (1 + 0.13 * t.power);
  const torque = spec.torque * (1 + 0.12 * t.power + 0.04 * t.turbo);
  const mass = spec.mass * (1 - 0.035 * t.weight);
  const grip = spec.grip * (1 + 0.045 * t.tire);
  const downforce = spec.downforce * (1 + 0.16 * t.aero);
  const topSpeed = spec.topSpeed * (1 + 0.055 * t.gear);
  const turbo = spec.turbo > 0 ? Math.min(1.25, spec.turbo * (1 + 0.10 * t.turbo)) : 0;
  const lag = spec.turbo > 0 ? Math.max(0.16, 0.62 - 0.07 * t.turbo) : 0.01;
  return { ...spec, power, torque, mass, grip, downforce, topSpeed, turbo, lag };
}

/** 最終減速比を「目標最高速で最終ギアがレッドに当たる」ように逆算します。 */
function finalDrive(spec) {
  const topMs = spec.topSpeed / KMH;
  const topGear = spec.gears[spec.gears.length - 1];
  return (spec.redline / RADS_TO_RPM) * spec.wheelR / (topMs * topGear);
}

/** 回転数に対するトルクの出方（1.0がピーク） */
function torqueShape(x) {
  const f = 0.654 + 1.116 * x - 0.9 * x * x;
  const low = clamp((x - 0.055) / 0.17, 0, 1);
  const cut = x > 1.0 ? clamp(1 - (x - 1.0) * 6, 0, 1) : 1;
  return Math.max(0, f) * (0.35 + 0.65 * low) * cut;
}

export class Vehicle {
  constructor(spec, tune, opts = {}) {
    this.baseSpec = spec;
    this.setTune(tune);
    this.isAI = !!opts.isAI;
    this.name = opts.name || spec.name;

    this.pos = new THREE.Vector3();
    this.heading = 0;      // ワールドのY軸まわり（+Zが0）
    this.vx = 0;           // 車体前後方向の速度[m/s]
    this.vy = 0;           // 車体左右方向の速度[m/s]（右が＋）
    this.yawRate = 0;
    this.gear = 1;         // 1..N（0はニュートラル、-1はR）
    this.rpm = spec.idle;
    this.boost = 0;
    this.shiftTimer = 0;
    this.steer = 0;
    this.slipRear = 0;
    this.slipFront = 0;
    this.wheelSpin = 0;
    this.onWall = 0;
    this.roll = 0;
    this.pitch = 0;
    this.wheelAngle = 0;
    this.distance = 0;
    this.s = 0; this.u = 0; this.trackIndex = 0;
    this.lastAx = 0; this.lastAy = 0;
    this.slipstream = 0;
    this.crashCooldown = 0;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, up: false, down: false };
  }

  setTune(tune) {
    this.tune = tune || { power: 0, weight: 0, tire: 0, aero: 0, gear: 0, turbo: 0 };
    this.spec = applyTune(this.baseSpec, this.tune);
    this.final = finalDrive(this.spec);
    // 出力[PS]から算出したトルク上限（ピークトルクとの整合をとる）
    this.maxGear = this.spec.gears.length;
  }

  placeOnTrack(track, s, u) {
    const sm = track.sample(s, {});
    this.pos.copy(sm.pos).addScaledVector(sm.lat, u).addScaledVector(sm.up, 0.02);
    this.heading = Math.atan2(sm.tan.x, sm.tan.z);
    this.s = s; this.u = u; this.trackIndex = sm.index;
    this.vx = 0; this.vy = 0; this.yawRate = 0;
    this.gear = 1; this.rpm = this.spec.idle; this.boost = 0;
  }

  get speedKmh() { return Math.abs(this.vx) * KMH; }

  gearRatio() {
    if (this.gear <= 0) return 0;
    return this.spec.gears[this.gear - 1];
  }

  /** 現ギアでの理論回転数 */
  rpmFor(v, gear) {
    const gr = gear <= 0 ? 0 : this.spec.gears[gear - 1];
    if (!gr) return this.spec.idle;
    return Math.abs(v) / this.spec.wheelR * gr * this.final * RADS_TO_RPM;
  }

  shiftUp() {
    if (this.gear < this.maxGear && this.shiftTimer <= 0) {
      this.gear++; this.shiftTimer = 0.16; return true;
    }
    return false;
  }
  shiftDown() {
    if (this.gear > 1 && this.shiftTimer <= 0) {
      const nr = this.rpmFor(this.vx, this.gear - 1);
      if (nr < this.spec.redline * 1.06) { this.gear--; this.shiftTimer = 0.16; return true; }
    }
    return false;
  }

  /** dt はサブステップ済みの短い時間刻み */
  step(dt, env) {
    const S = this.spec;
    const inp = this.input;
    const m = S.mass;
    const L = S.dims.WB;
    const lf = L * (1 - WEIGHT_BIAS[S.layout]);
    const lr = L * WEIGHT_BIAS[S.layout];
    const cgH = 0.42;
    const Iz = m * (S.dims.L * S.dims.L + S.dims.W * S.dims.W) / 12 * 1.05;

    // --- ステアリング（速度が乗るほど切れ角を絞る）
    const v = Math.abs(this.vx);
    const maxSteer = 0.55 / (1 + v * 0.042);
    const target = inp.steer * maxSteer;
    const rate = this.isAI ? 9.0 : 6.5;
    this.steer = damp(this.steer, target, rate, dt);
    const st = this.steer;

    // --- 変速
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const cut = this.shiftTimer > 0 ? 0 : 1;

    // --- エンジン
    const theoretical = this.rpmFor(this.vx, this.gear);
    const targetRpm = clamp(theoretical, S.idle, S.redline * 1.07);
    this.rpm = damp(this.rpm, this.shiftTimer > 0 ? Math.max(S.idle, targetRpm * 0.86) : targetRpm, 18, dt);

    const x = this.rpm / S.redline;
    // ターボの過給（アクセル量と回転数で立ち上がる）
    const boostTarget = inp.throttle * clamp((this.rpm - S.redline * 0.22) / (S.redline * 0.36), 0, 1);
    const lag = boostTarget > this.boost ? S.lag : S.lag * 0.35;
    this.boost = damp(this.boost, boostTarget, 1 / Math.max(0.05, lag), dt);
    const boostMul = S.turbo > 0
      ? (1 - 0.42 * S.turbo) + 0.42 * S.turbo * this.boost
      : 1;

    let engineTq = S.torque * torqueShape(x) * boostMul * inp.throttle * cut;
    if (inp.throttle < 0.02) engineTq = -S.torque * 0.055 * clamp(x, 0, 1.1); // エンジンブレーキ
    // 出力の頭打ち（PS換算）
    const wRad = Math.max(1, this.rpm / RADS_TO_RPM);
    const maxTq = (S.power * 735.49875) / wRad;
    if (engineTq > maxTq) engineTq = maxTq;

    const gr = this.gearRatio();
    let Fdrive = gr > 0 ? (engineTq * gr * this.final * DRIVE_EFF) / S.wheelR : 0;

    // --- 空力
    const dragK = 0.5 * RHO * S.cd * S.area * (1 - this.slipstream * 0.42);
    const Fdrag = dragK * v * v * Math.sign(this.vx || 1);
    const Froll = 0.0135 * m * G * Math.sign(this.vx || 1) * clamp(v / 2, 0, 1);
    const downforce = 0.5 * RHO * S.downforce * 1.6 * S.area * v * v; // [N]

    // --- ブレーキ
    const brakeMax = S.grip * m * G * 1.02;
    let Fbrake = inp.brake * brakeMax;

    // --- 荷重
    const ax = this.lastAx;
    const Wtot = m * G + downforce;
    let Nf = Wtot * (lr / L) - (m * ax * cgH) / L;
    let Nr = Wtot * (lf / L) + (m * ax * cgH) / L;
    Nf = Math.max(Wtot * 0.12, Nf);
    Nr = Math.max(Wtot * 0.12, Nr);

    const mu = S.grip * (env && env.wet ? 0.78 : 1);
    const muF = mu, muR = mu * (inp.handbrake > 0.5 ? 0.42 : 1);

    // --- タイヤのスリップ角と横力
    const vxs = Math.max(2.0, v);
    const af = Math.atan2(this.vy + this.yawRate * lf, vxs) - st * Math.sign(this.vx || 1);
    const ar = Math.atan2(this.vy - this.yawRate * lr, vxs);
    const Cf = 13.5 * Nf, Cr = 15.5 * Nr;
    let Fyf = -Cf * af;
    let Fyr = -Cr * ar;
    const maxFyf = muF * Nf, maxFyr = muR * Nr;

    // --- 前後力の配分と摩擦円
    const splitF = DRIVE_SPLIT[S.layout];
    let FxF = Fdrive * splitF - Fbrake * 0.64 * Math.sign(this.vx || 1);
    let FxR = Fdrive * (1 - splitF) - Fbrake * 0.36 * Math.sign(this.vx || 1);
    if (inp.handbrake > 0.5) FxR -= brakeMax * 0.30 * Math.sign(this.vx || 1);

    const circle = (Fx, Fy, maxF) => {
      const mag = Math.hypot(Fx, Fy);
      if (mag <= maxF || mag < 1e-3) return [Fx, Fy, 0];
      const k = maxF / mag;
      return [Fx * k, Fy * k, 1 - k];
    };
    let sf, sr;
    [FxF, Fyf, sf] = circle(FxF, clamp(Fyf, -maxFyf, maxFyf), muF * Nf);
    [FxR, Fyr, sr] = circle(FxR, clamp(Fyr, -maxFyr, maxFyr), muR * Nr);
    this.slipFront = damp(this.slipFront, sf, 12, dt);
    this.slipRear = damp(this.slipRear, sr, 12, dt);
    this.wheelSpin = damp(
      this.wheelSpin,
      clamp((Math.abs(Fdrive) - (muR * Nr + (splitF > 0 ? muF * Nf : 0))) / (m * G), 0, 1.4),
      10, dt
    );

    // --- 運動方程式
    const Fx = FxF * Math.cos(st) - Fyf * Math.sin(st) + FxR - Fdrag - Froll;
    const Fy = FxF * Math.sin(st) + Fyf * Math.cos(st) + Fyr;
    const axn = Fx / m + this.yawRate * this.vy;
    const ayn = Fy / m - this.yawRate * this.vx;
    const yawAcc = (lf * (Fyf * Math.cos(st) + FxF * Math.sin(st)) - lr * Fyr) / Iz;

    this.vx += axn * dt;
    this.vy += ayn * dt;
    this.yawRate += yawAcc * dt;
    // 低速の暴れ止め
    if (Math.abs(this.vx) < 0.6 && inp.throttle < 0.05) {
      this.vx *= 0.90; this.vy *= 0.75; this.yawRate *= 0.80;
    }
    this.yawRate *= Math.exp(-dt * 0.55);

    // --- スピン抑制（アーケード寄りの安定化）
    // タイヤが支えられる旋回の速さには上限があります。
    // それを大きく超えたぶんだけ強く減衰させることで、
    // 「一度回り出したら戻らない」状態を防ぎつつ、サイドブレーキでのドリフトは残します。
    const gripLat = mu * G * (1 + (downforce / Math.max(1, m * G)) * 0.9);
    const maxYaw = v > 3 ? gripLat / v : 4;
    const assist = inp.handbrake > 0.5 ? 1.9 : 1.15;
    if (Math.abs(this.yawRate) > maxYaw * assist) {
      const over = Math.abs(this.yawRate) / (maxYaw * assist);
      this.yawRate *= Math.exp(-dt * clamp((over - 1) * 9, 0, 26));
    }
    const slipAngle = Math.abs(Math.atan2(this.vy, Math.max(1, Math.abs(this.vx))));
    if (slipAngle > 0.5 && inp.handbrake < 0.5) {
      const k = clamp((slipAngle - 0.5) / 0.5, 0, 1);
      this.yawRate *= Math.exp(-dt * (1.4 + 8.0 * k));
      this.vy *= Math.exp(-dt * (1.0 + 5.0 * k));
    }
    this.yawRate = clamp(this.yawRate, -4.0, 4.0);
    this.vy = clamp(this.vy, -38, 38);
    this.vx = clamp(this.vx, -14, 130);

    this.lastAx = axn;
    this.lastAy = ayn;

    this.heading += this.yawRate * dt;
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    // 車体前方は +Z、右は +X
    this.pos.x += (this.vx * sn + this.vy * cs) * dt;
    this.pos.z += (this.vx * cs - this.vy * sn) * dt;
    this.distance += Math.abs(this.vx) * dt;

    // 見た目用のロール／ピッチ
    this.roll = damp(this.roll, clamp(-this.lastAy / (G * 2.4), -0.09, 0.09), 7, dt);
    this.pitch = damp(this.pitch, clamp(-this.lastAx / (G * 3.4), -0.055, 0.055), 7, dt);
    this.wheelAngle += (this.vx / S.wheelR) * dt;
    if (this.crashCooldown > 0) this.crashCooldown -= dt;
  }

  /** 1フレーム分を細かく刻んで進めます（高速域でも破綻しないように） */
  update(dt, env) {
    const n = clamp(Math.ceil(dt / (1 / 120)), 1, 8);
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h, env);
  }

  /** 壁との接触処理。track 上の u を見て押し戻します。 */
  resolveWalls(track, limits) {
    const pr = track.project(this.pos, this.trackIndex);
    this.trackIndex = pr.index;
    this.s = pr.s; this.u = pr.u;
    const half = S_halfWidth(this.spec);
    const outer = limits.outer - half;   // 路肩側（負の方向）
    const inner = limits.inner + half;   // 中央分離帯側
    let hit = 0;
    if (pr.u < -outer) { hit = -1; }
    else if (pr.u > -inner) { hit = 1; }
    if (hit !== 0) {
      const targetU = hit < 0 ? -outer : -inner;
      const sm = track.sample(pr.s, {});
      this.pos.copy(sm.pos).addScaledVector(sm.lat, targetU).addScaledVector(sm.up, 0.02);
      // 壁ずり：前進速度を削り、横速度を殺す
      const impact = Math.abs(this.vy) + Math.abs(this.yawRate) * 6;
      this.vy = 0;
      this.yawRate *= 0.25;
      this.vx *= 1 - clamp(0.05 + impact * 0.02, 0.03, 0.30);
      this.onWall = 1;
      return impact;
    }
    this.onWall = Math.max(0, this.onWall - 0.08);
    return 0;
  }

  /** 路面の高さ・傾きに車体を合わせます。 */
  snapToRoad(track) {
    const sm = track.sample(this.s, {});
    const p = sm.pos.clone().addScaledVector(sm.lat, this.u);
    this.pos.y = lerp(this.pos.y, p.y + 0.02, 0.4);
    return sm;
  }
}

function S_halfWidth(spec) { return spec.dims.W * 0.5 + 0.06; }

/** 前を走る車のスリップストリームに入っているか判定します。 */
export function slipstreamFactor(me, other) {
  if (!other) return 0;
  const dz = other.s - me.s;
  const wrap = 0;
  const gap = dz;
  if (gap < 3 || gap > 55) return 0;
  const du = Math.abs(other.u - me.u);
  if (du > 3.6) return 0;
  const g = 1 - (gap - 3) / 52;
  const l = 1 - du / 3.6;
  return clamp(g * l, 0, 1);
}
