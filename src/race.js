import { wrapDelta } from './net.js';

/**
 * オンラインでの勝負。
 *
 * 「同じ道に相手がいる」だけでは勝負になりません。合図と、ゴールと、
 * 勝ち負けが要ります。ここはその3つだけを持ちます。
 *
 * ■ 形式は「合図から一定距離の先着」
 * ゴール地点を決める形にすると、2人が同じ場所に並んでいないと成立しません。
 * 合図の瞬間からの走行距離で競えば、どこに居ても始められます。並んでから
 * 始めれば、そのまま並走の勝負になります。
 *
 * ■ 勝敗は「絶対時刻」ではなく「経過時間」で比べます
 * 相手の時計とこちらの時計は合っていません（合わせるには往復の計測が要り、
 * 毎秒10件の枠を食います）。そこで各自が「合図から何秒で走りきったか」を
 * 測り、その秒数だけを送って短いほうを勝ちにします。時計のずれは
 * 結果に影響しません。残るずれは合図が届くまでの片道ぶんだけです。
 */

export const DEFAULT_DIST = 5000;   // 勝負の距離[m]
const COUNT = 4.0;                  // カウントダウン[s]
const WAIT_LIMIT = 90;              // 相手のゴールを待つ上限[s]

export class Race {
  /**
   * @param net  Net（通信）
   * @param on   { onState(race), onMessage(text, sub, ms) } 画面へ伝えるための呼び出し
   */
  constructor(net, on = {}) {
    this.net = net;
    this.on = on;
    this.reset();
  }

  reset() {
    this.state = 'idle';   // idle | offered | invited | countdown | racing | done
    this.dist = DEFAULT_DIST;
    this.count = 0;
    this.t = 0;            // 合図からの経過[s]
    this.prog = 0;         // 合図からの走行距離[m]
    this.theirProg = 0;
    this.myTime = null;
    this.theirTime = null;
    this.result = null;    // 'win' | 'lose' | 'abort'
    this.peer = null;      // 相手のID
    this.peerName = '';
    this._lastS = null;
    this._wait = 0;
  }

  get active() { return this.state === 'countdown' || this.state === 'racing'; }
  /** 残り距離[m] */
  get left() { return Math.max(0, this.dist - this.prog); }
  /** 相手との差[m]。正なら自分が前 */
  get gap() { return this.prog - this.theirProg; }

  _say(text, sub, ms) { if (this.on.onMessage) this.on.onMessage(text, sub, ms); }
  _changed() { if (this.on.onState) this.on.onState(this); }

  /** 勝負を申し込みます */
  offer(dist) {
    if (this.state !== 'idle') return false;
    const other = this.net.others[0];
    if (!other) return false;
    this.dist = dist || DEFAULT_DIST;
    this.peer = other.id;
    this.peerName = (other.info && other.info.name) || '相手';
    this.state = 'offered';
    this.net.control({ type: 'offer', dist: this.dist });
    this._say('申し込み中', `${this.peerName} の返事を待っています`, 2600);
    this._changed();
    return true;
  }

  /** 申し込みを受けます */
  accept() {
    if (this.state !== 'invited') return false;
    this.net.control({ type: 'accept' });
    this._start();
    return true;
  }

  decline() {
    if (this.state !== 'invited') return false;
    this.net.control({ type: 'decline' });
    this.reset();
    this._changed();
    return true;
  }

  /** 走行中にやめる／相手が居なくなった */
  abort(silent) {
    if (this.state === 'idle') return;
    if (!silent) this.net.control({ type: 'abort' });
    const wasRacing = this.active;
    this.reset();
    if (wasRacing) this._say('中止', '勝負は取りやめになりました', 2200);
    this._changed();
  }

  _start() {
    this.state = 'countdown';
    this.count = COUNT;
    this.t = 0;
    this.prog = 0;
    this.theirProg = 0;
    this.myTime = null;
    this.theirTime = null;
    this.result = null;
    this._lastS = null;
    this._wait = 0;
    this._changed();
  }

  /** 相手から届いたやり取り */
  onMessage(from, msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'offer': {
        // すでに何かしているときは断ります
        if (this.state !== 'idle') { this.net.control({ type: 'decline' }); return; }
        const m = this.net.members.get(from);
        this.peer = from;
        this.peerName = (m && m.info && m.info.name) || '相手';
        this.dist = Math.max(500, Math.min(30000, Number(msg.dist) || DEFAULT_DIST));
        this.state = 'invited';
        this._say('勝負を申し込まれました', `${this.peerName} ／ ${(this.dist / 1000).toFixed(1)} km`, 4000);
        this._changed();
        break;
      }
      case 'accept':
        if (this.state !== 'offered') return;
        this._start();
        break;
      case 'decline':
        if (this.state !== 'offered') return;
        this._say('断られました', `${this.peerName} は今は走らないようです`, 2400);
        this.reset();
        this._changed();
        break;
      case 'finish':
        // ゴールの知らせは、走っている最中でも終わったあとでも受け取ります
        if (this.state !== 'racing' && this.state !== 'done') return;
        this.theirTime = Number(msg.t) || 0;
        this._decide();
        break;
      case 'abort':
        this.abort(true);
        break;
      default:
        break;
    }
  }

  /**
   * @param dt 経過時間
   * @param v  自車
   * @param trackLength コース1周の長さ
   */
  update(dt, v, trackLength) {
    if (this.state === 'countdown') {
      const before = Math.ceil(this.count);
      this.count -= dt;
      const now = Math.ceil(this.count);
      if (now !== before && now > 0) this._say(String(now), '', 900);
      if (this.count <= 0) {
        this.state = 'racing';
        this._lastS = v.s;
        this._say('GO', `${(this.dist / 1000).toFixed(1)} km 先着`, 1400);
        this._changed();
      }
      return;
    }

    if (this.state === 'racing') {
      this.t += dt;
      // 走った距離を足していきます。s の差をそのまま使うと、1周を跨いだ
      // ところで大きく飛びます。また、PAからの復帰などで場所が飛んだ回は
      // 数えません（進んだことにすると、瞬間移動が近道になってしまいます）
      if (this._lastS !== null) {
        const d = wrapDelta(v.s - this._lastS, trackLength);
        if (Math.abs(d) < 200) this.prog += d;
      }
      this._lastS = v.s;

      if (this.prog >= this.dist && this.myTime === null) {
        this.myTime = this.t;
        this.net.control({ type: 'finish', t: +this.t.toFixed(2) });
        this.state = 'done';
        this._decide();
      }
      return;
    }

    if (this.state === 'done' && this.result === null) {
      // 相手のゴールを待ちます。居なくなったらこちらの勝ちにします
      this._wait += dt;
      if (!this.net.members.has(this.peer)) { this.theirTime = Infinity; this._decide(); return; }
      if (this._wait > WAIT_LIMIT) { this.theirTime = Infinity; this._decide(); }
    }
  }

  /** 相手が受け取った進捗（10Hz の位置と一緒に届きます） */
  setTheirProgress(p) {
    if (typeof p === 'number' && this.active) this.theirProg = p;
  }

  _decide() {
    if (this.myTime === null || this.theirTime === null) return;
    const win = this.myTime <= this.theirTime;
    this.result = win ? 'win' : 'lose';
    const mine = this.myTime.toFixed(2);
    const theirs = this.theirTime === Infinity ? '—' : this.theirTime.toFixed(2);
    this._say(win ? 'WIN' : 'LOSE', `${mine} 秒 ／ ${this.peerName} ${theirs} 秒`, 5200);
    this._changed();
  }
}
