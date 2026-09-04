import { clamp, lerp, formatMoney } from './util.js';
/** 画面表示（スピードメーター・タコメーター・バトルゲージ・ミニマップ）をまとめて更新します。 */
export class HUD {
  constructor(root, track) {
    this.root = root;
    this.track = track;
    this.el = {
      speed: root.querySelector('#hud-speed'),
      gear: root.querySelector('#hud-gear'),
      boostBar: root.querySelector('#hud-boost-fill'),
      tacho: root.querySelector('#hud-tacho'),
      minimap: root.querySelector('#hud-minimap'),
      battle: root.querySelector('#hud-battle'),
      barMe: root.querySelector('#bar-me'),
      barYou: root.querySelector('#bar-you'),
      nameMe: root.querySelector('#name-me'),
      nameYou: root.querySelector('#name-you'),
      gap: root.querySelector('#hud-gap'),
      time: root.querySelector('#hud-time'),
      best: root.querySelector('#hud-best'),
      msg: root.querySelector('#hud-msg'),
      sub: root.querySelector('#hud-sub'),
      zone: root.querySelector('#hud-zone'),
      money: root.querySelector('#hud-money'),
    };
    this.tctx = this.el.tacho.getContext('2d');
    this.mctx = this.el.minimap.getContext('2d');
    this._resizeCanvases();
    this._buildMinimapPath();
    this.msgTimer = 0;
  }

  /**
   * HUD が非表示のあいだは clientWidth が 0 になるため、
   * 表示されたタイミングで作り直せるよう毎フレーム軽くチェックします。
   */
  _resizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!this._fallback) {
      this._fallback = new Map([[this.el.tacho, [210, 118]], [this.el.minimap, [150, 150]]]);
    }
    const fallback = this._fallback;
    let changed = false;
    for (const cv of [this.el.tacho, this.el.minimap]) {
      const [fw, fh] = fallback.get(cv);
      const w = Math.max(8, Math.round(cv.clientWidth || fw));
      const h = Math.max(8, Math.round(cv.clientHeight || fh));
      if (cv._cssW === w && cv._cssH === h) continue;
      cv._cssW = w; cv._cssH = h;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      changed = true;
    }
    return changed;
  }

  /** コースが変わったら、ミニマップの座標系を作り直します。 */
  setTrack(track) {
    this.track = track;
    this._buildMinimapPath();
  }

  _buildMinimapPath() {
    const t = this.track;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < t.n; i += 4) {
      const x = t.pos[i * 3], z = t.pos[i * 3 + 2];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    this.mm = { minX, maxX, minZ, maxZ };
  }

  _mmPt(x, z, w, h) {
    const { minX, maxX, minZ, maxZ } = this.mm;
    const pad = 8;
    const sx = (w - pad * 2) / (maxX - minX);
    const sz = (h - pad * 2) / (maxZ - minZ);
    const s = Math.min(sx, sz);
    return [
      pad + (x - minX) * s + ((w - pad * 2) - (maxX - minX) * s) / 2,
      pad + (z - minZ) * s + ((h - pad * 2) - (maxZ - minZ) * s) / 2,
    ];
  }

  drawTacho(rpm, redline, gear, boost) {
    const g = this.tctx;
    const cv = this.el.tacho;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.width / dpr, h = cv.height / dpr;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.92, R = Math.min(w * 0.46, h * 0.86);
    if (R < 20) return;
    const A0 = Math.PI * 0.98, A1 = Math.PI * 2.02;

    // 目盛り
    const maxR = Math.ceil((redline * 1.12) / 1000) * 1000;
    g.lineWidth = 2;
    for (let r = 0; r <= maxR; r += 1000) {
      const a = lerp(A0, A1, r / maxR);
      const isRed = r >= redline;
      g.strokeStyle = isRed ? 'rgba(255,60,50,0.9)' : 'rgba(190,205,225,0.55)';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
      g.fillStyle = isRed ? 'rgba(255,110,100,0.95)' : 'rgba(175,190,210,0.8)';
      g.font = '600 10px "Roboto Condensed",system-ui,sans-serif';
      g.textAlign = 'center';
      g.fillText(String(r / 1000), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24) + 3.5);
    }
    // 現在値の弧
    const t = clamp(rpm / maxR, 0, 1);
    const a = lerp(A0, A1, t);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#39d0ff');
    grad.addColorStop(0.72, '#7ee0ff');
    grad.addColorStop(1, '#ff3b30');
    g.strokeStyle = grad;
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, R - 5, A0, a);
    g.stroke();
    // レッド手前のシフト警告（外周のリング）
    const warn = clamp((rpm - redline * 0.90) / (redline * 0.10), 0, 1);
    if (warn > 0) {
      const blink = rpm >= redline ? (Math.sin(performance.now() * 0.03) > 0 ? 1 : 0.25) : 1;
      g.strokeStyle = `rgba(255,${Math.round(90 - warn * 60)},40,${(0.35 + warn * 0.65) * blink})`;
      g.lineWidth = 3.5;
      g.beginPath();
      g.arc(cx, cy, R + 3, A0, A1);
      g.stroke();
    }

    // 針
    g.strokeStyle = rpm > redline ? '#ff4d40' : '#eaf4ff';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10);
    g.lineTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14));
    g.stroke();
  }

  drawMinimap(playerS, playerU, others) {
    const g = this.mctx;
    const cv = this.el.minimap;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.width / dpr, h = cv.height / dpr;
    g.clearRect(0, 0, w, h);
    if (w < 20 || h < 20) return;
    const t = this.track;
    // 下地（太く暗い線）→ 本線（明るい線）の二度描きで、暗い背景でも輪郭が読めます
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= t.n; i += 6) {
        const j = i % t.n;
        const [x, y] = this._mmPt(t.pos[j * 3], t.pos[j * 3 + 2], w, h);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
    };
    g.strokeStyle = 'rgba(6,10,18,0.9)';
    g.lineWidth = 6;
    path(); g.stroke();
    g.strokeStyle = 'rgba(196,214,238,0.85)';
    g.lineWidth = 2.4;
    path(); g.stroke();

    // トンネル区間だけ色を変えて、いま自分がどこを走っているか分かるように
    g.strokeStyle = 'rgba(255,180,60,0.9)';
    g.lineWidth = 2.6;
    for (const z of t.zones) {
      if (z.kind !== 'tunnel') continue;
      g.beginPath();
      for (let s2 = z.from; s2 <= z.to; s2 += 40) {
        const j = Math.floor((s2 / t.spacing)) % t.n;
        const [x, y] = this._mmPt(t.pos[j * 3], t.pos[j * 3 + 2], w, h);
        if (s2 === z.from) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }

    const dot = (s, color, r = 3.4, ring = false) => {
      const sm = t.sample(s, this._dotTmp || (this._dotTmp = {}));
      const [x, y] = this._mmPt(sm.pos.x, sm.pos.z, w, h);
      if (ring) {
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, r + 1.5, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    for (const o of others) dot(o.s, o.color || '#ff5a4d', 3.6, true);
    dot(playerS, '#5ff0ff', 4.6, true);
  }

  setBattle(on, meName, youName) {
    this.el.battle.style.display = on ? '' : 'none';
    if (on) {
      this.el.nameMe.textContent = meName;
      this.el.nameYou.textContent = youName;
    }
  }

  updateBattle(meLife, youLife, gap) {
    this.el.barMe.style.width = `${clamp(meLife, 0, 1) * 100}%`;
    this.el.barYou.style.width = `${clamp(youLife, 0, 1) * 100}%`;
    const ahead = gap >= 0;
    this.el.gap.textContent = `${ahead ? '+' : '−'}${Math.abs(gap).toFixed(0)} m`;
    this.el.gap.className = ahead ? 'ahead' : 'behind';
  }

  message(text, sub = '', ms = 1800) {
    this.el.msg.textContent = text;
    this.el.sub.textContent = sub;
    this.el.msg.classList.remove('pop');
    void this.el.msg.offsetWidth;
    this.el.msg.classList.add('pop');
    this.msgTimer = ms / 1000;
  }

  update(dt, st) {
    this._resizeCanvases();
    const v = st.player;
    this.el.speed.textContent = String(Math.round(v.speedKmh)).padStart(3, ' ');
    this.el.gear.textContent = v.gear <= 0 ? 'N' : String(v.gear);
    this.el.boostBar.style.width = `${clamp(v.boost, 0, 1) * 100}%`;
    this.drawTacho(v.rpm, v.spec.redline, v.gear, v.boost);
    this.drawMinimap(v.s, v.u, st.others || []);
    if (this.el.time) this.el.time.textContent = st.timeText || '';
    if (this.el.best) this.el.best.textContent = st.bestText || '';
    if (this.el.zone) this.el.zone.textContent = st.zoneText || '';
    if (this.el.money) this.el.money.textContent = `¥${formatMoney(st.money || 0)}`;
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) { this.el.msg.textContent = ''; this.el.sub.textContent = ''; }
    }
  }
}
