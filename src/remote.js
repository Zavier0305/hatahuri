import * as THREE from 'three';
import { clamp, wrapAngle } from './util.js';
import { Actor } from './actors.js';
import { CARS } from './cars.js';
import { wrapDelta, now } from './net.js';

/**
 * 相手の車。
 *
 * 届くのは毎秒10回だけで、しかも片道50〜150msの遅れがあります。そのまま
 * 描くと、相手は 1/10 秒ごとにカクッと動く「100ms前の姿」になります。
 * そこで2段構えにします。
 *
 *   予測 … 最後に届いた位置から、届いた変化率で「いまどこにいるはずか」を伸ばす
 *   均し … 予測が外れて次の実測が来たとき、差を一気に埋めず数フレームで寄せる
 *
 * 均しを入れないと、パケットが1つ飛んだだけで相手が数メートル瞬間移動します。
 * 当たり判定を入れている以上、その瞬間移動は「当たっていないのに当たった」に
 * 直結するので、飛んだ直後は当たり判定を止めます（graceTimer）。
 */

const MAX_EXTRAPOLATE = 0.35;   // 予測で伸ばす上限[s]。これ以上は当てになりません
/*
 * 片道の遅延の見込み[s]。
 *
 * 相手が送ってからこちらに届くまでの時間は、往復を測らないと分かりません。
 * 往復を測ると毎秒10件の枠を食うので、Pusher の典型値を置いています。
 * ここが実際より小さいと相手が後ろにずれ、大きいと前にずれます。
 */
const LAG_COMP = 0.06;
const SNAP_DIST = 18;           // これだけ離れたら均さずに飛ばす[m]
const EASE = 9;                 // 均しの速さ
const GRACE = 0.25;             // 飛んだ直後、当たり判定を止める時間[s]

export class RemoteCar {
  constructor(member, scene, track) {
    this.id = member.id;
    this.info = member.info || {};
    this.name = this.info.name || '名無し';
    const spec = CARS.find((c) => c.id === this.info.carId) || CARS[0];
    this.actor = new Actor(spec, null, scene, { color: this.info.color || 0x8899aa, isAI: true });
    this.vehicle = this.actor.vehicle;
    this.vehicle.isRemote = true;
    this.track = track;
    this.spec = spec;

    this.have = false;          // 一度でも位置を受け取ったか
    this.graceTimer = 0;
    // 予測と描画の「ずれ」。0 へ減衰させることで、位置そのものを引きずらずに
    // 補正だけを滑らかにします
    this.errS = 0; this.errU = 0; this.errH = 0;
    this.lastSeen = now();
    this.rtt = 0;
    // 描画に使う現在値。予測値へ向かって寄せていきます
    this.s = 0; this.u = 0; this.h = 0; this.v = 0; this.z = 0;
  }

  /** 相手が黙ってから何秒経ったか。長いと接続が切れたとみなします */
  get silence() { return (now() - this.lastSeen) / 1000; }

  /**
   * @param states net.js が溜めている受信履歴（古い順）
   */
  update(dt, states) {
    const last = states && states.length ? states[states.length - 1] : null;
    if (this.graceTimer > 0) this.graceTimer -= dt;
    if (!last) return;
    if (last.at !== this._lastAt) { this._lastAt = last.at; this.lastSeen = now(); }

    // いまどこにいるはずか。
    // 「届いた時刻」ではなく「相手が撮った時刻」から測ります。届いた時刻を
    // 起点にすると、通信にかかった時間ぶんまるごと後ろにずれます。
    const captured = last.offset !== null && last.offset !== undefined && last.t !== undefined
      ? last.t + last.offset
      : last.at;
    const age = clamp((now() - captured) / 1000 + LAG_COMP, 0, MAX_EXTRAPOLATE);
    const L = this.track.length;
    let ts = last.s + (last.ds || 0) * age;
    const tu = last.u + (last.du || 0) * age;
    const th = last.h + (last.w || 0) * age;
    ts = ((ts % L) + L) % L;

    /*
     * 描画位置は「予測 ＋ 残っているずれ」。ずれだけを 0 へ減衰させます。
     *
     * 素直に「描画位置を予測位置へ近づける」書き方にすると、相手が走って
     * いるあいだ予測位置は動き続けるので、いつまでも追いつけません。
     * 追従の速さを k とすると、速度 V で走る相手には常に V/k だけ遅れます。
     * 40m/s・k=9 なら 4.4m ＝ ほぼ車1台ぶん後ろにずれたまま描かれます。
     * 当たり判定を入れている以上、この定常的なずれはそのまま
     * 「当たっていないのに当たった」になります。
     *
     * そこで、新しい位置が届いた瞬間だけ「それまで描いていた場所と予測との
     * 差」をずれとして記録し、あとはそれを減衰させます。こうすると相手が
     * 等速で走っているあいだ遅れは 0 になり、補正は滑らかなままです。
     */
    const fresh = last.at !== this._usedAt;
    if (!this.have) {
      this.have = true;
      this.errS = this.errU = this.errH = 0;
      this.graceTimer = GRACE;
    } else if (fresh) {
      const gap = wrapDelta(this.s - ts, L);
      if (Math.abs(gap) > SNAP_DIST) {
        // 大きく外れたときは繋がずに飛ばします。中途半端に引きずるほうが
        // 「泳いでくる」ように見えて悪目立ちします
        this.errS = this.errU = this.errH = 0;
        this.graceTimer = GRACE;
      } else {
        this.errS = gap;
        this.errU = this.u - tu;
        this.errH = wrapAngle(this.h - th);
      }
    }
    this._usedAt = last.at;
    const decay = Math.exp(-EASE * dt);
    this.errS *= decay; this.errU *= decay; this.errH *= decay;
    this.s = ts + this.errS;
    this.u = tu + this.errU;
    this.h = th + this.errH;
    this.s = ((this.s % L) + L) % L;
    this.v = last.v || 0;
    this.z = last.z || 0;

    // 見た目の車へ反映します。物理は回しません（相手の車は相手のもの）
    const v = this.vehicle;
    v.s = this.s; v.u = this.u; v.heading = this.h;
    v.vx = this.v;
    v.yawRate = last.w || 0;
    v.onRamp = this.z === 1; v.onSurface = this.z === 2; v.onAlley = this.z === 3;
    const sm = this.track.sample(this.s, v._sm || (v._sm = {}));
    const drop = this.z === 0 ? 0 : dropFor(this.track, this.s, this.z);
    v.pos.copy(sm.pos).addScaledVector(sm.lat, this.u).addScaledVector(sm.up, drop + 0.02);
    v.trackIndex = sm.index;
    this.actor.syncMesh(this.track);
  }

  dispose(scene) { this.actor.dispose(scene); }
}

/** ランプ・一般道・路地では路面の高さが本線と違います */
function dropFor(track, s, z) {
  if (z === 2 && track.surfaceAt) { const sf = track.surfaceAt(s); return sf ? sf.h : 0; }
  if (z === 3 && track.alleyAt && track.surfaceAt) { const sf = track.surfaceAt(s); return sf ? sf.h : 0; }
  if (z === 1 && track.rampAt) { const r = track.rampAt(s); return r ? r.h || 0 : 0; }
  return 0;
}

/**
 * 自車と相手の当たり判定。
 *
 * 大事なのは「動かすのは自分の車だけ」という点です。相手の車を押し返すと、
 * 次に相手から届く位置と喧嘩して、2台がぶるぶる震えます。相手の画面でも
 * 同じ計算が同時に走っているので、互いに自分のぶんだけ退けば、合計で
 * ちょうど重なりぶん離れます。
 *
 * 押し出す量は相手との重さの比で決めます。軽い車のほうが大きく弾かれる、
 * という既存の一般車との衝突と同じ考え方です。
 */
export function collideRemote(game, remote) {
  if (!remote.have || remote.graceTimer > 0) return 0;
  const a = game.player.vehicle;
  const b = remote.vehicle;
  // 別の道にいるあいだは当たりません（本線と一般道は上下に11m離れています）
  const za = a.onAlley ? 3 : a.onSurface ? 2 : a.onRamp ? 1 : 0;
  if (za !== remote.z) return 0;

  const L = game.track.length;
  const ds = wrapDelta(a.s - remote.s, L);
  const penL = (a.spec.dims.L + b.spec.dims.L) * 0.5 - Math.abs(ds);
  if (penL <= 0) return 0;
  const du = a.u - remote.u;
  const penW = (a.spec.dims.W + b.spec.dims.W) * 0.5 - Math.abs(du);
  if (penW <= 0) return 0;

  const ma = a.spec.mass, mb = b.spec.mass;
  const wa = mb / (ma + mb);      // 自分が退くぶん。相手は相手の画面で残りを退きます

  if (penW < penL * 0.55) {
    const dir = du >= 0 ? 1 : -1;
    game.moveOnTrack(a, 0, dir * penW * wa);
    a.vy = dir * Math.abs(a.vy) * 0.3 + dir * 1.2;
    a.vx *= 0.995;
    game.shake = Math.max(game.shake, 0.18);
  } else {
    const dir = ds > 0 ? 1 : -1;
    game.moveOnTrack(a, dir * penL * wa, 0);
    // 相手の速度は届いた値をそのまま使います
    const e = 0.22;
    a.vx = (ma * a.vx + mb * b.vx + mb * e * (b.vx - a.vx)) / (ma + mb);
    game.shake = Math.max(game.shake, 0.3);
  }
  if (a.crashCooldown <= 0) {
    a.crashCooldown = 0.25;
    game.emitSparks(a, 10);
  }
  return Math.max(penL, penW);
}

/** 相手の名前を頭の上に出す板。誰と走っているか分からないと対戦になりません */
export function makeTag(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.font = 'bold 34px "Zen Kaku Gothic New", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(text, 128, 34);
  g.fillStyle = '#eaf0f8';
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(4.2, 1.05, 1);
  sp.renderOrder = 8;
  return sp;
}
