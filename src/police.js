import * as THREE from 'three';
import { clamp } from './util.js';
import { LANE_U, ROAD } from './track.js';
import { CAR_BY_ID } from './cars.js';
import { Actor, softDot } from './actors.js';
import { RivalAI } from './ai.js';

/**
 * 高速隊（パトカー）と手配度。
 *
 * フリーランに「やってはいけないこと」を作るための仕組みです。
 * 速く走りつづける・ぶつける・壁を擦る、で手配度が上がり、上がった数だけ
 * パトカーが後ろから追ってきます。振り切れば下がり、捕まれば罰金です。
 *
 * パトカーは本線しか走れません（AIはランプへ降りない）。そのため
 * 「パーキングエリアへ逃げ込むと巻ける」という遊びが、特別な処理を書かなくても
 * そのまま成立します。
 */

/** これを超えた速度で走りつづけると手配度が上がります[km/h] */
const LIMIT_KMH = 140;
/** 一般道での制限。高速と同じ基準では、街中を200km/hで走ってもお咎めなしになります。 */
const SURF_LIMIT_KMH = 80;
export const MAX_LEVEL = 3;

/** 手配度ごとのパトカーの仕様。上の階級ほど速い個体が出ます。 */
// 最上位は、フルチューンの自車と同じ最高速まで持たせています。
// ここを控えめにすると、仕上がった車では手配度3でも一切怖くありません。
const UNIT = [
  null,
  { count: 1, tune: { power: 2, weight: 1, tire: 2, aero: 1, gear: 1, turbo: 2 }, skill: 0.84 },
  { count: 2, tune: { power: 3, weight: 2, tire: 3, aero: 2, gear: 3, turbo: 3 }, skill: 0.89 },
  { count: 3, tune: { power: 5, weight: 4, tire: 5, aero: 4, gear: 5, turbo: 5 }, skill: 0.95 },
];

/**
 * 屋根の赤色灯と、車体の塗り分け。
 * 白いだけでは、遠目には一般車と見分けがつきません。
 * 日本の高速隊と同じ「上が白・下が黒」にして、屋根に赤色灯を載せます。
 */
function liveryAndBar(spec) {
  const g = new THREE.Group();
  const D = spec.dims;
  const dark = new THREE.MeshStandardMaterial({ color: 0x0d1015, roughness: 0.55, metalness: 0.2 });
  // 下半分の黒。ボディよりわずかに外へ出して、面が重なってちらつくのを防ぎます
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(D.W * 1.005, D.H * 0.30, D.L * 0.86), dark);
  skirt.position.y = D.H * 0.17;
  g.add(skirt);

  const bar = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(D.W * 0.66, 0.09, 0.30),
    new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.7, metalness: 0.2 })
  );
  base.position.y = 0.045;
  bar.add(base);
  const lamps = [];
  for (const [dx, col] of [[-1, 0xff2a2a], [1, 0x2a6bff]]) {
    const m = new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 0.2, roughness: 0.35,
    });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(D.W * 0.30, 0.15, 0.28), m);
    lamp.position.set(dx * D.W * 0.17, 0.17, 0);
    bar.add(lamp);
    lamps.push(m);
  }
  bar.position.set(0, D.H * 0.86, -0.15);
  g.add(bar);
  return { group: g, lamps };
}

/**
 * 路面へ落ちる赤青の光。
 * 実際の光源を車ごとに足すと、全マテリアルのシェーダが重くなります。
 * 路面に落ちた光の板だけで、夜の見え方はほぼ同じになります。
 */
function flashPool(color) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 18),
    new THREE.MeshBasicMaterial({
      // 縁がぼけていないと、路面に色板が置いてあるようにしか見えません
      map: softDot(0.10), color, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}

export class Police {
  constructor(scene, track, opts = {}) {
    this.scene = scene;
    this.track = track;
    this.onEvent = opts.onEvent || (() => {});
    this.enabled = false;
    this.wet = false;
    this.heat = 0;        // 0..MAX_LEVEL。整数部が手配度
    this.units = [];
    this.evade = 0;       // 振り切っている時間[s]
    this.bust = 0;        // 捕まりかけている時間[s]
    this.blink = 0;
    this.crashCd = 0;     // 追突で手配度を上げたあとの待ち時間[s]
    this.redCd = 0;       // 信号無視を数えたあとの待ち時間[s]
    this._sm = {};
  }

  get level() { return Math.min(MAX_LEVEL, Math.floor(this.heat)); }
  get active() { return this.units.length > 0; }

  setTrack(track) {
    this.track = track;
    this.clear();
  }

  /** 全部片付けて手配度も0に戻します。 */
  clear() {
    for (const u of this.units) {
      u.actor.dispose(this.scene);
      this.scene.remove(u.flashA);
      this.scene.remove(u.flashB);
      u.flashA.geometry.dispose(); u.flashA.material.dispose();
      u.flashB.geometry.dispose(); u.flashB.material.dispose();
    }
    this.units = [];
    this.heat = 0;
    this.evade = 0;
    this.bust = 0;
  }

  /** 自車の後方に1台出します。 */
  spawn(player) {
    const cfg = UNIT[Math.max(1, this.level)];
    const spec = CAR_BY_ID.bnr34;
    const actor = new Actor(spec, cfg.tune, this.scene, {
      isAI: true, color: 0xeef1f5, name: 'POLICE',
    });
    actor.vehicle.name = '高速隊';
    const bar = liveryAndBar(spec);
    actor.mesh.add(bar.group);

    const ai = new RivalAI(actor.vehicle, this.track, {
      skill: cfg.skill, aggression: 0.9,
      // 追う側なので、離されるほど強く詰めます。
      // 通常のライバル(0.10)のままだと、チューンした自車には一生追いつけません。
      rubber: 0.42,
    });
    ai.gripScale = this.wet ? 0.80 : 1;
    // 一般道まで追ってこられるようにします（ほかのAIは本線から出しません）
    actor.vehicle.offRoadAI = true;

    const flashA = flashPool(0xff2a2a);
    const flashB = flashPool(0x2a6bff);
    this.scene.add(flashA); this.scene.add(flashB);

    const u = { actor, ai, lamps: bar.lamps, flashA, flashB, surf: false };
    this.place(u, player, this.units.length);
    this.units.push(u);
    return u;
  }

  /**
   * 1台を自車の後方へ置きます。
   * 自車が一般道にいるなら、パトカーも一般道へ出します。
   * 本線に湧かせたままだと、高架の上を並走するだけで永久に追いつけません。
   */
  place(u, player, idx = 0) {
    const pv = player.vehicle;
    const surf = !!(pv.onSurface && this.track.surfaceAt);
    u.surf = surf;
    const back = (surf ? 90 + Math.random() * 70 : 190 + Math.random() * 90);
    const s0 = pv.s - back;
    const av = u.actor.vehicle;
    if (surf) {
      const sf = this.track.surfaceAt(s0);
      av.placeOnTrack(this.track, s0, sf ? sf.u - 1.7 : 0, { onSurface: !!sf });
      av.vx = Math.max(30, Math.abs(pv.vx) * 0.95);
      av.gear = 3;
    } else {
      av.placeOnTrack(this.track, s0, LANE_U[idx % LANE_U.length]);
      av.vx = Math.max(45, Math.abs(pv.vx) * 0.95);
      av.gear = 5;
    }
  }

  /**
   * 一般道でのパトカーの運転。
   * RivalAI は本線の車線を狙うので、そのままでは一般道の外へ出ようとします。
   * 一般道は道なりに走るだけなので、簡単な追従で足ります。
   */
  driveSurface(u, dt, player) {
    const av = u.actor.vehicle;
    const sf = this.track.surfaceAt(av.s);
    if (!sf) return;
    const inp = av.input;
    const Ld = Math.max(22, Math.abs(av.vx) * 1.2);
    const ah = this.track.surfaceAt(av.s + Ld) || sf;
    // 自分と同じ向きの車線（中心より左）を狙います
    const want = ah.u - 1.7;
    inp.steer = clamp(-Math.atan2((av.u - want) * 1.2, Ld) * 2.4, -1, 1);
    // 逃げる相手に合わせて追い上げます（制限速度は無視します）
    const pv = player.vehicle;
    const L = this.track.length;
    let gap = pv.s - av.s;
    if (gap > L / 2) gap -= L;
    if (gap < -L / 2) gap += L;
    const target = clamp(Math.abs(pv.vx) + clamp(gap * 0.12, -6, 14), 12, 46);
    const e = target - av.vx;
    inp.throttle = clamp(e * 0.35, 0, 1);
    inp.brake = clamp(-e * 0.35, 0, 1);
    inp.handbrake = 0;
    if (av.shiftTimer <= 0) {
      if (av.rpm > av.spec.redline * 0.95 && av.gear < av.maxGear) av.shiftUp();
      else if (av.rpm < av.spec.redline * 0.45 && av.gear > 1) av.shiftDown();
    }
  }

  /** 手配度に見合う台数へ増減させます。 */
  fleet(player) {
    const want = this.level > 0 ? UNIT[this.level].count : 0;
    while (this.units.length < want) this.spawn(player);
    while (this.units.length > want) {
      const u = this.units.pop();
      u.actor.dispose(this.scene);
      this.scene.remove(u.flashA); this.scene.remove(u.flashB);
      u.flashA.geometry.dispose(); u.flashA.material.dispose();
      u.flashB.geometry.dispose(); u.flashB.material.dispose();
    }
  }

  /**
   * 一番近いパトカーとの距離[m]（見つからなければ Infinity）。
   *
   * 進行方向の差だけで測ってはいけません。パトカーは本線しか走れないので、
   * 一般道やパーキングエリアにいる自車とは s が同じでも 11m 下にいます。
   * s だけで測っていたため、真上の本線にいるパトカーに「連行」されていました
   * （「PAへ逃げ込めば巻ける」という作りと正面から矛盾していました）。
   * 横位置の差も入れて測ります。
   */
  nearest(v) {
    const L = this.track.length;
    let best = Infinity;
    for (const u of this.units) {
      let d = u.actor.vehicle.s - v.s;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      best = Math.min(best, Math.hypot(d, u.actor.vehicle.u - v.u));
    }
    return best;
  }

  /** 信号無視。1回ぶん（続けて何度も数えないよう間隔を空けます）。 */
  runRed() {
    if (!this.enabled || this.redCd > 0) return false;
    this.redCd = 3;
    this.heat = clamp(this.heat + 0.30, 0, MAX_LEVEL + 0.999);
    return true;
  }

  /**
   * 壁ずりで手配度を上げます。接触しているあいだ毎フレーム呼ばれるので、
   * 「時間あたり」で積みます。1回ぶんとして積むと、壁に沿って数秒こするだけで
   * 手配度が最大になりました（実際になりました）。
   */
  scrape(dt, severity) {
    if (!this.enabled) return;
    this.heat = clamp(this.heat + clamp(severity / 26, 0.05, 0.5) * 0.22 * dt, 0, MAX_LEVEL + 0.999);
  }

  /**
   * 追突で手配度を上げます。こちらは1回ぶん。
   * めり込んでいるあいだは毎フレーム検出されるので、間隔を空けます。
   */
  impact(severity) {
    if (!this.enabled || this.crashCd > 0) return;
    this.crashCd = 1.6;
    this.heat = clamp(this.heat + clamp(severity * 0.35, 0.05, 0.30), 0, MAX_LEVEL + 0.999);
  }

  /**
   * @param dt        経過時間
   * @param player    自車の Actor
   * @param obstacles AI に渡す障害物リスト
   */
  update(dt, player, obstacles) {
    const v = player.vehicle;
    if (!this.enabled) {
      if (this.units.length) this.clear();
      return;
    }
    const before = this.level;
    this.crashCd = Math.max(0, this.crashCd - dt);
    this.redCd = Math.max(0, this.redCd - dt);

    // --- 手配度の増減
    // 速度超過は「超えているあいだ、超えたぶんだけ」積み上がります。
    const limit = v.onSurface ? SURF_LIMIT_KMH : LIMIT_KMH;
    const over = clamp((v.speedKmh - limit) / 140, 0, 1);
    if (over > 0) this.heat = Math.min(MAX_LEVEL + 0.999, this.heat + over * 0.085 * dt);

    // 振り切り判定。
    // 速度超過を続けているあいだは、どれだけ離しても振り切ったことになりません。
    // ここを見ないと、速い車では「離す→冷める」が延々と繰り返され、手配度が
    // 2以上に上がらないままでした（追われている実感がまるで出ませんでした）。
    // つまり逃げ切るには「速度を落とす」か「ランプへ降りる」しかありません。
    // ランプへ降りればパトカーは付いてこられません（AIは本線から出ないため）。
    const near = this.nearest(v);
    this._near = near;
    // 一般道もランプと同じで、パトカーは降りてこられません
    // 路地とパーキングエリアは、パトカーが入ってこられない逃げ場です
    const hidden = v.onRamp || v.onAlley;
    const away = over <= 0.001 && (near > 300 || hidden);
    if (this.level > 0 && away) {
      this.evade += dt * (hidden ? 2.4 : 1);
      if (this.evade > 9) {
        this.evade = 0;
        this.heat = Math.max(0, Math.floor(this.heat) - 1 + 0.99);
        if (this.level === 0) this.heat = 0;
      }
    } else {
      this.evade = Math.max(0, this.evade - dt * 2);
    }

    // 捕まる判定。真後ろに付かれて速度を落とすと連行されます。
    // パーキングエリアの中では捕まりません。一般道まで追ってくるようにしたので、
    // どこかに「確実に逃げ込める場所」を残しておかないと、逃げ道のない
    // 鬼ごっこになります。パトカーは広場へは入らず、一般道を通り過ぎます。
    if (this.level > 0 && !v.onRamp && !v.onAlley && near < 16 && v.speedKmh < 45) {
      this.bust += dt;
      if (this.bust > 2.5) {
        const lv = this.level;
        this.bust = 0;
        this.heat = 0;
        this.onEvent('busted', { level: lv, fine: 80000 * lv });
      }
    } else {
      this.bust = Math.max(0, this.bust - dt * 1.5);
    }

    this.fleet(player);
    if (this.level !== before) this.onEvent('wanted', { level: this.level, was: before });

    // --- 走らせる
    const L = this.track.length;
    this.blink += dt;
    const on = (this.blink * 4.4) % 2 < 1;   // 赤と青が交互
    const wantSurf = !!(v.onSurface && this.track.surfaceAt);
    for (const u of this.units) {
      const pv2 = u.actor.vehicle;
      // 自車が高速と一般道を行き来したら、パトカーもそちらへ移します
      if (u.surf !== wantSurf) this.place(u, player, this.units.indexOf(u));
      let gap = v.s - pv2.s;
      if (gap > L / 2) gap -= L;
      if (gap < -L / 2) gap += L;
      if (u.surf) this.driveSurface(u, dt, player);
      else u.ai.update(dt, obstacles, gap);
      pv2.update(dt, { wet: this.wet });
      pv2.resolveWalls(this.track, { outer: ROAD.halfRoad - 0.35, inner: ROAD.medianHalf + 0.25 }, dt);
      pv2.snapToRoad(this.track);
      u.actor.wet = this.wet;
      u.actor.syncMesh(this.track);

      // 赤色灯
      u.lamps[0].emissiveIntensity = on ? 9.0 : 0.12;
      u.lamps[1].emissiveIntensity = on ? 0.12 : 9.0;
      const sm = this.track.sample(pv2.s, this._sm);
      for (const [mesh, lit] of [[u.flashA, on], [u.flashB, !on]]) {
        // 車の実際の位置を使います。本線の高さで置くと、一般道を走っている
        // あいだ、光だけが11m上の高架の上に残ります。
        mesh.position.copy(pv2.pos).addScaledVector(sm.up, 0.04);
        mesh.material.opacity = lit ? 0.55 : 0.05;
      }
    }
  }

  /** HUD・音へ渡す状態 */
  state() {
    if (!this.enabled) return null;
    return {
      level: this.level,
      heat: this.heat - Math.floor(this.heat),
      chasing: this.units.length > 0,
      near: this._near === undefined ? Infinity : this._near,
      evade: this.level > 0 ? clamp(this.evade / 9, 0, 1) : 0,
      bust: clamp(this.bust / 2.5, 0, 1),
    };
  }
}
