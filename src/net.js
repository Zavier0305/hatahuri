/**
 * オンライン対戦の通信層。
 *
 * Pusher Channels を使います。本来はチャットや通知向けのサービスなので、
 * レースに使ううえで効いてくる制限が2つあります。
 *
 *   1. クライアント間で直接送れるイベントは 1接続あたり毎秒10件まで
 *   2. 無料枠は 1日20万メッセージ / 同時接続100
 *
 * そこで送信は 10Hz に固定し、あいだは受信側で予測して埋めます（remote.js）。
 * 人数が増えると通信量は人数の2乗で増えるため、部屋は1対1を想定しています。
 *
 * 送る中身は「コース上の距離 s・横位置 u・向き」だけです。コースは種から
 * 手続き生成されるので、地形は一切送りません。1台ぶんが数値7個で済みます。
 *
 * 通信の実体は Transport として差し替えられるようにしてあります。テストでは
 * ブラウザ内で完結する LoopbackTransport を挿し、鍵なしで2台ぶんの
 * やり取りを再現します。
 */

export const SEND_HZ = 10;
export const SEND_INTERVAL = 1 / SEND_HZ;

/** 合言葉からチャンネル名を作ります。合言葉そのものは外に出しません。 */
export async function roomChannel(passphrase) {
  const norm = String(passphrase || '').trim().toLowerCase();
  const bytes = new TextEncoder().encode(`wangan:${norm}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `presence-wangan-${hex}`;
}

/** 62KB を読むのはオンラインに入るときだけです */
let pusherLoading = null;
export function loadPusher(src = './vendor/pusher.min.js') {
  if (typeof window !== 'undefined' && window.Pusher) return Promise.resolve(window.Pusher);
  if (pusherLoading) return pusherLoading;
  pusherLoading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => (window.Pusher ? resolve(window.Pusher) : reject(new Error('Pusher を読み込めませんでした')));
    el.onerror = () => { pusherLoading = null; reject(new Error('Pusher を読み込めませんでした')); };
    document.head.appendChild(el);
  });
  return pusherLoading;
}

/** 実際に Pusher へつなぐ経路 */
export class PusherTransport {
  constructor(opts = {}) {
    this.key = opts.key;
    this.cluster = opts.cluster || 'ap3';
    this.authEndpoint = opts.authEndpoint || '/api/pusher-auth';
    this.scriptSrc = opts.scriptSrc;
    this.client = null;
    this.channel = null;
  }

  async join(channelName, profile, handlers) {
    const Pusher = await loadPusher(this.scriptSrc);
    this.client = new Pusher(this.key, {
      cluster: this.cluster,
      channelAuthorization: { endpoint: this.authEndpoint, transport: 'ajax', params: profile },
      enabledTransports: ['ws', 'wss'],
      activityTimeout: 30000,
    });
    this.client.connection.bind('error', (e) => handlers.onError(describe(e)));
    this.client.connection.bind('unavailable', () => handlers.onError('接続できません（回線かPusherの設定を確認してください）'));

    const ch = this.client.subscribe(channelName);
    this.channel = ch;
    ch.bind('pusher:subscription_succeeded', (members) => {
      const list = [];
      members.each((m) => { if (m.id !== members.myID) list.push({ id: m.id, info: m.info }); });
      handlers.onReady(members.myID, list);
    });
    ch.bind('pusher:subscription_error', (e) => {
      // 認証で落ちるのがいちばん多いので、原因を切り分けられる文言にします
      const s = (e && (e.status || (e.error && e.error.data && e.error.data.code))) || '';
      handlers.onError(
        s === 403 || s === 401
          ? '部屋に入れませんでした（サーバの鍵の設定を確認してください）'
          : `部屋に入れませんでした（${s || '原因不明'}）`
      );
    });
    ch.bind('pusher:member_added', (m) => handlers.onJoin({ id: m.id, info: m.info }));
    ch.bind('pusher:member_removed', (m) => handlers.onLeave(m.id));
    ch.bind('client-state', (data, meta) => handlers.onState(senderOf(meta), data));
    // 勝負の申し込みや結果。数は少ないので 10Hz の枠をほとんど食いません
    ch.bind('client-race', (data, meta) => handlers.onControl(senderOf(meta), data));
  }

  send(event, data) {
    if (!this.channel) return false;
    return this.channel.trigger(`client-${event}`, data) !== false;
  }

  leave() {
    try { if (this.client) this.client.disconnect(); } catch { /* 切断時の例外は無視 */ }
    this.client = null; this.channel = null;
  }
}

function deliver(peer, from, event, data) {
  if (!peer.handlers) return;
  if (event === 'state') peer.handlers.onState(from, data);
  else peer.handlers.onControl(from, data);
}

function senderOf(meta) {
  return (meta && (meta.user_id || meta.userId)) || null;
}

function describe(e) {
  const d = e && e.error && e.error.data;
  if (d && d.code === 4001) return 'アプリキーが違います';
  if (d && d.code >= 4000 && d.code < 4100) return `接続を拒否されました（${d.code}）`;
  return '接続でエラーが起きました';
}

/**
 * 鍵なしで動く経路。テストと、同じ端末での動作確認に使います。
 * 送ったものが同じページの別インスタンスへそのまま届きます。
 */
export class LoopbackTransport {
  static hubs = new Map();
  static queue = [];

  constructor(opts = {}) {
    this.id = opts.id || `L${Math.random().toString(36).slice(2, 8)}`;
    this.lagMs = opts.lagMs || 0;       // 片道の遅延[ms]。遅延の影響を試すため
    this.dropRate = opts.dropRate || 0; // 落ちる割合 0..1
    this.hub = null; this.name = null; this.handlers = null; this.info = null;
  }

  async join(channelName, profile, handlers) {
    this.name = channelName; this.handlers = handlers;
    this.info = { name: profile.name, carId: profile.carId, color: profile.color, courseId: profile.courseId };
    let hub = LoopbackTransport.hubs.get(channelName);
    if (!hub) { hub = new Set(); LoopbackTransport.hubs.set(channelName, hub); }
    this.hub = hub;
    const others = [...hub].map((p) => ({ id: p.id, info: p.info }));
    hub.add(this);
    for (const p of hub) if (p !== this) p.handlers.onJoin({ id: this.id, info: this.info });
    handlers.onReady(this.id, others);
  }

  send(event, data) {
    if (!this.hub) return false;
    LoopbackTransport.pump();
    for (const p of this.hub) {
      if (p === this) continue;
      // 勝負のやり取りは落としません。位置は次が来ますが、これは来ないので
      if (event === 'state' && this.dropRate && Math.random() < this.dropRate) continue;
      if (!this.lagMs) { deliver(p, this.id, event, data); continue; }
      LoopbackTransport.queue.push({ due: now() + this.lagMs, from: this.id, to: p, event, data });
    }
    return true;
  }

  /**
   * 届く時刻になったものを配ります。
   * setTimeout ではなく now() を見るので、テストが時計を進めれば、実時間を
   * 待たずに遅延を再現できます。
   */
  static pump() {
    const q = LoopbackTransport.queue;
    if (!q.length) return;
    const t = now();
    let i = 0;
    while (i < q.length) {
      const m = q[i];
      if (m.due > t) { i++; continue; }
      q.splice(i, 1);
      deliver(m.to, m.from, m.event, m.data);
    }
  }

  leave() {
    if (!this.hub) return;
    this.hub.delete(this);
    for (const p of this.hub) p.handlers.onLeave(this.id);
    if (!this.hub.size) LoopbackTransport.hubs.delete(this.name);
    this.hub = null; this.handlers = null;
  }
}

/**
 * 通信の口。ゲーム側はこのクラスだけを見ます。
 *
 * 送信は 10Hz に間引きます。Pusher の上限がちょうど毎秒10件なので、
 * フレームごとに送ると即座に弾かれます。
 */
export class Net {
  constructor(transport) {
    this.tp = transport;
    this.myId = null;
    this.members = new Map();   // id -> { info, states: [] }
    this.status = 'idle';       // idle | joining | joined | error
    this.error = '';
    this.acc = 0;
    this.seq = 0;
    this.sent = 0;
    this.recv = 0;
    this.onChange = null;       // 参加者が増減したときの通知
    this.onControl = null;      // 勝負のやり取りが届いたとき (from, msg)
  }

  get others() { return [...this.members.values()]; }
  get count() { return this.members.size; }

  async join(channelName, profile) {
    this.status = 'joining'; this.error = '';
    try {
      await this.tp.join(channelName, profile, {
        onReady: (myId, list) => {
          this.myId = myId;
          for (const m of list) this._add(m);
          this.status = 'joined';
          this._changed();
        },
        onJoin: (m) => { this._add(m); this._changed(); },
        onLeave: (id) => { this.members.delete(id); this._changed(); },
        onState: (id, data) => this._state(id, data),
        onControl: (id, msg) => { if (this.onControl) this.onControl(id, msg); },
        onError: (msg) => { this.status = 'error'; this.error = msg; this._changed(); },
      });
    } catch (e) {
      this.status = 'error';
      this.error = (e && e.message) || '接続に失敗しました';
      this._changed();
    }
  }

  _add(m) {
    if (!m || !m.id || m.id === this.myId) return;
    // offset は「相手の時計 → こちらの時計」のずれ。下の _state で詰めます
    this.members.set(m.id, { id: m.id, info: m.info || {}, states: [], offset: null });
  }

  _changed() { if (this.onChange) this.onChange(this); }

  _state(id, data) {
    const m = this.members.get(id);
    if (!m || !data) return;
    this.recv++;
    // 遅れて届いたものは捨てます。順序が入れ替わると位置が巻き戻ります
    const last = m.states[m.states.length - 1];
    if (last && data.n !== undefined && last.n !== undefined && data.n <= last.n) return;
    const at = now();
    /*
     * 相手の時計との差を見積もります。
     *
     * 「届いた時刻 − 相手が送った時刻」は、時計のずれ ＋ 片道の遅延です。
     * このうち遅延は毎回ばらつくので、いちばん小さかった値を採ると
     * 「時計のずれ ＋ 最短の遅延」に収束します。これを使うと、10Hz の
     * 送信間隔のばらつき（0〜100ms）を予測から追い出せます。
     *
     * 片道の遅延そのものは、往復を測らないと分離できません（往復は
     * 毎秒10件の枠を食うので測りません）。そのぶんは LAG_COMP で見ます。
     */
    if (data.t !== undefined) {
      const d = at - data.t;
      if (m.offset === null || d < m.offset) m.offset = d;
    }
    m.states.push({ ...data, at, offset: m.offset });
    if (m.states.length > 6) m.states.shift();
  }

  /**
   * 自車の状態を送ります。dt を足していき、10Hz を超えたぶんだけ送信します。
   * @returns 実際に送ったか
   */
  tick(dt, state) {
    if (this.status !== 'joined') return false;
    this.acc += dt;
    if (this.acc < SEND_INTERVAL) return false;
    // 0 に戻すと余りが毎回切り捨てられ、60fps では 7フレームに1回＝8.6Hz まで
    // 落ちます。間隔ぶんだけ引いて余りを次に持ち越します。
    this.acc -= SEND_INTERVAL;
    if (this.acc > SEND_INTERVAL) this.acc = 0;   // 大きく飛んだときは溜め込まない
    this.seq++;
    const ok = this.tp.send('state', { ...state, n: this.seq });
    if (ok) this.sent++;
    return ok;
  }

  /** 勝負の申し込みなど、数の少ないやり取り。10Hz の間引きは通しません */
  control(msg) {
    if (this.status !== 'joined') return false;
    return this.tp.send('race', msg);
  }

  leave() {
    try { this.tp.leave(); } catch { /* 切断時の例外は無視 */ }
    this.members.clear();
    this.myId = null;
    this.status = 'idle';
    this._changed();
  }
}

let clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 時計を差し替えます。テスト専用です。
 *
 * 物理を早送りするテストでは実時間がほとんど進まないため、実時計のままだと
 * 「遅延」も「相手が黙った時間」も再現できません。ここを差し替えられるように
 * しておくと、遅延やパケット落ちの挙動を毎回同じ結果で確かめられます。
 */
export function setClock(fn) { clock = fn || (() => performance.now()); }

export function now() { return clock(); }

/**
 * 自車から、送るぶんの数値だけを抜き出します。
 *
 * prev には前回この関数が返したものを渡します。s と u の「変化率」を一緒に
 * 送るためで、受信側はこれをそのまま掛け算するだけで先を読めます。速度と
 * 向きから毎回起こし直すより、コースに沿った動きを素直に再現できます。
 *
 * @param trackLength コース1周の長さ。s の折り返しを跨いだ差分の計算に要ります
 */
export function sampleState(v, prev, trackLength) {
  const s = v.s, u = v.u;
  let ds = 0, du = 0;
  if (prev && prev.t) {
    const dt = Math.max(1e-3, (now() - prev.t) / 1000);
    ds = wrapDelta(s - prev.s, trackLength) / dt;
    du = (u - prev.u) / dt;
  }
  return {
    s: round(s, 2), u: round(u, 2), h: round(v.heading, 3),
    ds: round(ds, 2), du: round(du, 2),
    w: round(v.yawRate, 3), v: round(v.vx, 2),
    z: v.onAlley ? 3 : v.onSurface ? 2 : v.onRamp ? 1 : 0,
    t: now(),
  };
}

export function wrapDelta(d, len) {
  if (!len) return d;
  if (d > len / 2) return d - len;
  if (d < -len / 2) return d + len;
  return d;
}

function round(v, n) {
  const k = 10 ** n;
  return Math.round(v * k) / k;
}
