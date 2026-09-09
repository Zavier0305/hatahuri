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
      clock: root.querySelector('#hud-clock'),
      money: root.querySelector('#hud-money'),
      wanted: root.querySelector('#hud-wanted'),
      wantedStars: Array.from(root.querySelectorAll('#hud-wanted .wt-stars i')),
      wantedBar: root.querySelector('#hud-wanted .wt-bar'),
      wantedFill: root.querySelector('#hud-wanted .wt-bar span'),
      wantedNote: root.querySelector('#hud-wanted .wt-note'),
      prompt: root.querySelector('#hud-prompt'),
      job: root.querySelector('#hud-job'),
      jobKind: root.querySelector('#hud-job .jb-kind'),
      jobTime: root.querySelector('#hud-job .jb-time'),
      jobTo: root.querySelector('#hud-job .jb-to'),
      jobMeta: root.querySelector('#hud-job .jb-meta'),
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
    // 一般道の形。走っている場所が地図に無いと、自分がどこにいるか分かりません
    this.surfPath = null;
    if (track.surfaceAt && track.surfaceNodes) {
      const pts = [];
      const sm = {};
      const N = 160;
      for (let i = 0; i <= N; i++) {
        const s2 = (i / N) * track.length;
        const sf = track.surfaceAt(s2);
        if (!sf) { pts.length = 0; break; }
        track.sample(s2, sm);
        pts.push(sm.pos.x + sm.lat.x * sf.u, sm.pos.z + sm.lat.z * sf.u);
      }
      if (pts.length) this.surfPath = pts;
    }
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

    // 一般道（本線の外側を一周している側道）
    if (this.surfPath) {
      g.beginPath();
      for (let i = 0; i < this.surfPath.length; i += 2) {
        const [x, y] = this._mmPt(this.surfPath[i], this.surfPath[i + 1], w, h);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.strokeStyle = 'rgba(6,10,18,0.8)'; g.lineWidth = 3.4; g.stroke();
      g.strokeStyle = 'rgba(120,148,180,0.75)'; g.lineWidth = 1.2; g.stroke();
    }

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

    const dot = (s, color, r = 3.4, ring = false, u = 0) => {
      const sm = t.sample(s, this._dotTmp || (this._dotTmp = {}));
      const [x, y] = this._mmPt(sm.pos.x + sm.lat.x * u, sm.pos.z + sm.lat.z * u, w, h);
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
    // パーキングエリアの位置。どこで降りられるか分からないと、
    // 降りられること自体に気づけません
    if (this.paMarks) {
      for (const m of this.paMarks) {
        const sm = t.sample(m.s, this._dotTmp || (this._dotTmp = {}));
        const [x, y] = this._mmPt(sm.pos.x, sm.pos.z, w, h);
        g.fillStyle = 'rgba(47,123,234,0.95)';
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.lineWidth = 2.4;
        g.beginPath(); g.rect(x - 3, y - 3, 6, 6); g.stroke(); g.fill();
      }
    }
    // 依頼の行き先。どこへ向かえばいいのか分からないと依頼が成立しません
    if (this.jobDest !== null && this.jobDest !== undefined) {
      const sm = t.sample(this.jobDest, this._dotTmp || (this._dotTmp = {}));
      const [x, y] = this._mmPt(sm.pos.x, sm.pos.z, w, h);
      g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = '#5ff0ff'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#5ff0ff';
      g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
    }
    for (const o of others) dot(o.s, o.color || '#ff5a4d', 3.6, true);
    // 一般道にいるときは、外側の線の上に自車を出します
    dot(playerS, '#5ff0ff', 4.6, true, this.playerOffMain ? playerU : 0);
  }

  /** 地図に出すパーキングエリアの位置（コースを切り替えるたびに渡します） */
  setPaMarks(list) { this.paMarks = list || null; }

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

  /**
   * 手配度。
   * 星の数＝追ってくるパトカーの台数。下のバーは、追われていないときは
   * 「次の星までの溜まり具合」、追われているときは「振り切りまで」または
   * 「捕まるまで」を出します。何が起きているのか分からないまま
   * 手配度だけ上がるのを避けるためです。
   */
  setWanted(p) {
    const el = this.el.wanted;
    if (!el) return;
    if (!p || (p.level === 0 && p.heat < 0.02)) { el.style.display = 'none'; return; }
    el.style.display = '';
    for (let i = 0; i < this.el.wantedStars.length; i++) {
      this.el.wantedStars[i].classList.toggle('on', i < p.level);
    }
    const bar = this.el.wantedBar;
    bar.classList.remove('evade', 'bust');
    let w = p.heat, note = '';
    if (p.bust > 0.02) { bar.classList.add('bust'); w = p.bust; note = '停止命令'; }
    else if (p.evade > 0.02) { bar.classList.add('evade'); w = p.evade; note = '振り切り中'; }
    else if (p.chasing) note = '追跡中';
    else if (p.heat > 0.02) note = '速度超過';
    this.el.wantedFill.style.width = `${clamp(w, 0, 1) * 100}%`;
    this.el.wantedNote.textContent = note;
    el.classList.toggle('chase', !!p.chasing);
  }

  /**
   * パーキングエリアでできること（近づいたときだけ出します）。
   * 複数あるので、キーを振ったボタンを縦に並べます。
   * onAction を差し込むと、押されたときに番号で返ってきます。
   */
  setPrompt(list) {
    const el = this.el.prompt;
    if (!el) return;
    if (!list || !list.length) { el.style.display = 'none'; this._promptKey = null; return; }
    const key = list.map((a) => `${a.key}|${a.label}|${a.sub}`).join('/');
    if (key !== this._promptKey) {
      this._promptKey = key;
      el.innerHTML = list.map((a, i) => (
        `<button class="pr-btn" data-i="${i}">`
        + `<kbd>${a.key}</kbd><span><b></b><i></i></span></button>`
      )).join('');
      // ラベルは textContent で入れます（相手の名前などをそのまま埋め込まないため）
      const btns = Array.from(el.querySelectorAll('.pr-btn'));
      btns.forEach((b, i) => {
        b.querySelector('b').textContent = list[i].label;
        b.querySelector('i').textContent = list[i].sub || '';
        b.addEventListener('click', (e) => {
          e.preventDefault();
          if (this.onAction) this.onAction(i);
        });
      });
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    el.style.display = '';
  }

  /** 受けている依頼 */
  setJob(j) {
    const el = this.el.job;
    if (!el) return;
    if (!j) { el.style.display = 'none'; this.jobDest = null; return; }
    this.jobDest = j.destS;
    el.style.display = '';
    el.classList.toggle('urgent', !!j.urgent);
    this.el.jobKind.textContent = j.label;
    this.el.jobTime.textContent = `${j.time.toFixed(1)}s`;
    this.el.jobTo.textContent = `${j.to} まで ${(j.dist / 1000).toFixed(1)} km`;
    this.el.jobMeta.textContent = j.note
      ? `${j.note} ／ ¥${formatMoney(j.reward)}`
      : `報酬 ¥${formatMoney(j.reward)}`;
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
    this.playerOffMain = !!(v.onRamp || v.onSurface);
    this.drawMinimap(v.s, v.u, st.others || []);
    if (this.el.time) this.el.time.textContent = st.timeText || '';
    if (this.el.best) this.el.best.textContent = st.bestText || '';
    if (this.el.zone) this.el.zone.textContent = st.zoneText || '';
    if (this.el.clock) this.el.clock.textContent = st.clock || '';
    if (st.battle) this.updateBattle(st.battle.life, st.battle.rivalLife, st.battle.gap);
    this.setPrompt(st.actions);
    this.setWanted(st.police);
    this.setJob(st.job);
    if (this.el.money) this.el.money.textContent = `¥${formatMoney(st.money || 0)}`;
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) { this.el.msg.textContent = ''; this.el.sub.textContent = ''; }
    }
  }
}
