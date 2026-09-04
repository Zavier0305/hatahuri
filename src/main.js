import * as THREE from 'three';
import { Game, CAM_MODES } from './game.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { CARS, CAR_BY_ID } from './cars.js';
import { RIVALS } from './story.js';
import { COURSES, COURSE_BY_ID, DEFAULT_COURSE } from './courses.js';
import { load, save, resetSave, emptyTune } from './save.js';
import { applyTune } from './vehicle.js';
import { buildCar } from './carModel.js';
import { formatMoney, formatTime, clamp } from './util.js';
// ---------------------------------------------------------------- 状態

let data = load();
let game = null;
let hud = null;
const input = new Input();
const audio = new AudioEngine();

const TUNE_KEYS = [
  { k: 'power', label: 'パワー', desc: 'ブースト圧とタービン容量' },
  { k: 'weight', label: '軽量化', desc: '内装剥がしと軽量パーツ' },
  { k: 'tire', label: 'タイヤ', desc: 'グリップ' },
  { k: 'aero', label: 'エアロ', desc: '高速の安定' },
  { k: 'gear', label: 'ギア比', desc: '最高速寄り' },
  { k: 'turbo', label: 'タービン', desc: 'レスポンス' },
];
const TUNE_COST = [220000, 380000, 620000, 980000, 1500000];
const COLOR_SWATCH = [
  0x1b2733, 0x101318, 0xd8d8d2, 0x8a9099, 0xc03018, 0x2f6fd0,
  0xe8c520, 0x1b47b0, 0x2b3a4a, 0x2d6b46, 0x6a2a5c, 0xdadde2,
];

const VERSION = 'v1.0.0';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------------------------------------------------------------- 画面切替

let current = 'loading';
let paused = false;

function show(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = $(`#scr-${id}`);
  if (el) el.classList.add('active');
  current = id;
  const inGame = id === 'none' || id === 'pause';
  $('#hud').classList.toggle('hidden', !inGame);
  if (game) {
    // メニュー中は自動走行のデモに切り替え
    if (!inGame && id !== 'result') { game.setRival(null); game.setDemo(true); }
    else if (inGame) game.setDemo(false);
  }
  input.enabled = true;
  if (id === 'course') renderCourses();
  if (id === 'garage') renderGarage();
  if (id === 'story') renderStory();
  if (id === 'settings') syncSettings();
  menuIndex = 0;
  requestAnimationFrame(() => paintMenu(menuButtons()));
}

function hideAll() { show('none'); }

/**
 * メニューをキーボードだけで操作できるようにします。
 * ↑↓ で選択、Enter で決定、Esc で戻る。
 * ゲームパッドやキーボードだけで一周できることは、この手のゲームでは前提です。
 */
let menuIndex = 0;
function menuButtons() {
  const scr = $(`#scr-${current}`);
  if (!scr) return [];
  return Array.from(scr.querySelectorAll('.menu button, .rival-card:not(.locked), .back'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
}
function paintMenu(items) {
  items.forEach((el, i) => el.classList.toggle('sel', i === menuIndex));
  const el = items[menuIndex];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}
function menuKey(code) {
  const items = menuButtons();
  if (!items.length) return false;
  if (code === 'ArrowDown' || code === 'KeyS') { menuIndex = (menuIndex + 1) % items.length; paintMenu(items); return true; }
  if (code === 'ArrowUp' || code === 'KeyW') { menuIndex = (menuIndex - 1 + items.length) % items.length; paintMenu(items); return true; }
  if (code === 'Enter' || code === 'Space') { items[Math.min(menuIndex, items.length - 1)].click(); return true; }
  return false;
}

/** 初回だけ操作ガイドを出します（2回目以降は出しません） */
function showFirstHint() {
  if (data.hintSeen) return;
  const el = $('#first-hint');
  el.classList.remove('hidden');
  const close = () => {
    el.classList.add('hidden');
    data.hintSeen = true;
    save(data);
    window.removeEventListener('keydown', close);
    window.removeEventListener('pointerdown', close);
  };
  window.addEventListener('keydown', close);
  window.addEventListener('pointerdown', close);
  setTimeout(close, 9000);
}

// ---------------------------------------------------------------- ガレージ

let selCarId = null;
let preview = null;

function tuneOf(carId) {
  if (!data.tunes[carId]) data.tunes[carId] = emptyTune();
  return data.tunes[carId];
}
function colorOf(carId) {
  return data.colors[carId] ?? CAR_BY_ID[carId].color;
}
function owned(carId) { return data.owned.includes(carId); }

function initPreview() {
  if (preview) return;
  const cv = $('#preview');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 2, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0x7f96bc, 0x0a0e16, 1.0));
  // 夜明けの配色に合わせた三点照明（暖色のキー、冷たいリム、東の空からの弱いフィル）
  const key = new THREE.DirectionalLight(0xffe6c8, 1.25);
  key.position.set(4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fd4ff, 1.7);
  rim.position.set(-5, 3, -6); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xff9a52, 0.85);
  fill.position.set(3, 1.0, -5); scene.add(fill);
  // 床は中心から外へ消えるように。単色の円板だと縁が出て「板の上の模型」に見えます。
  const floorTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g2 = cv.getContext('2d');
    const grd = g2.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = grd;
    g2.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  })();
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(7.2, 64),
    new THREE.MeshStandardMaterial({
      color: 0x0d1220, roughness: 0.35, metalness: 0.55,
      transparent: true, alphaMap: floorTex, depthWrite: false,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const holder = new THREE.Group();
  scene.add(holder);
  preview = { renderer, scene, camera, holder, angle: 0.6, car: null };
}

function setPreviewCar(carId) {
  initPreview();
  if (preview.car) preview.holder.remove(preview.car);
  const built = buildCar(CAR_BY_ID[carId], { color: colorOf(carId) });
  preview.car = built.root;
  preview.holder.add(built.root);
}

function renderPreview() {
  if (!preview || current !== 'garage') return;
  const cv = $('#preview');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (w && h && (cv.width !== w * preview.renderer.getPixelRatio())) {
    preview.renderer.setSize(w, h, false);
    preview.camera.aspect = w / h;
    preview.camera.updateProjectionMatrix();
  }
  preview.angle += 0.0055;
  preview.holder.rotation.y = preview.angle;
  const r = 6.5;
  preview.camera.position.set(Math.sin(0.95) * r, 1.95, Math.cos(0.95) * r);
  preview.camera.lookAt(0, 0.62, 0);
  preview.renderer.render(preview.scene, preview.camera);
}

function specRow(k, v, u = '') {
  return `<div class="spec"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div></div>`;
}

function renderGarage() {
  if (!selCarId) selCarId = data.carId;
  $('#garage-money').textContent = `¥${formatMoney(data.money)}`;

  // 一覧
  $('#car-list').innerHTML = CARS.map((c) => {
    const own = owned(c.id);
    return `<div class="car-row ${c.id === selCarId ? 'sel' : ''}" data-car="${c.id}">
      <i class="sw" style="background:#${colorOf(c.id).toString(16).padStart(6, '0')}"></i>
      <div><div class="nm">${c.name}</div><div class="ch">${c.maker} · ${c.chassis}</div></div>
      ${own ? '<span class="own">OWNED</span>' : `<span class="lock">¥${formatMoney(c.price)}</span>`}
    </div>`;
  }).join('');
  $$('#car-list .car-row').forEach((el) =>
    el.addEventListener('click', () => { selCarId = el.dataset.car; renderGarage(); })
  );

  const c = CAR_BY_ID[selCarId];
  const t = tuneOf(selCarId);
  const eff = applyTune(c, t);
  setPreviewCar(selCarId);

  $('#d-maker').textContent = c.maker;
  $('#d-name').textContent = c.name;
  $('#d-chassis').textContent = `${c.chassis} / ${c.year} / ${c.layout}`;
  $('#d-price').textContent = owned(c.id) ? '所有中' : `¥${formatMoney(c.price)}`;
  $('#d-engine').textContent = c.engine;
  $('#d-note').textContent = c.note;

  const pw = Math.round(eff.power), tq = Math.round(eff.torque), ms = Math.round(eff.mass);
  $('#d-specs').innerHTML = [
    specRow('POWER', pw, ' ps'),
    specRow('TORQUE', tq, ' N·m'),
    specRow('WEIGHT', ms, ' kg'),
    specRow('P/W', (ms / pw).toFixed(2), ' kg/ps'),
    specRow('DRIVE', c.layout),
    specRow('TOP', Math.round(eff.topSpeed), ' km/h'),
  ].join('');

  // チューン
  $('#tune-list').innerHTML = TUNE_KEYS.map(({ k, label }) => {
    const lv = t[k];
    const cost = lv < 5 ? TUNE_COST[lv] : 0;
    const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('');
    return `<div class="tune-row">
      <span class="k">${label}</span>
      <span class="pips">${pips}</span>
      <button data-dn="${k}" ${lv <= 0 ? 'disabled' : ''}>−</button>
      <button data-up="${k}" ${lv >= 5 || data.money < cost || !owned(c.id) ? 'disabled' : ''}>＋</button>
      <span class="cost">${lv >= 5 ? 'MAX' : `¥${formatMoney(cost)}`}</span>
    </div>`;
  }).join('');
  $$('#tune-list [data-up]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.up, lv = t[k];
    if (lv >= 5 || data.money < TUNE_COST[lv]) return;
    data.money -= TUNE_COST[lv];
    t[k] = lv + 1;
    save(data); renderGarage(); audio.beep(1040, 0.08, 0.12);
  }));
  $$('#tune-list [data-dn]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.dn;
    if (t[k] <= 0) return;
    t[k] -= 1;
    data.money += Math.round(TUNE_COST[t[k]] * 0.55); // 下取り
    save(data); renderGarage();
  }));

  // カラー
  $('#color-row').innerHTML = COLOR_SWATCH.map((col) =>
    `<button data-col="${col}" class="${colorOf(c.id) === col ? 'sel' : ''}" style="background:#${col.toString(16).padStart(6, '0')}"></button>`
  ).join('');
  $$('#color-row [data-col]').forEach((b) => b.addEventListener('click', () => {
    data.colors[c.id] = Number(b.dataset.col);
    save(data); renderGarage();
  }));

  const sel = $('#btn-select'), buy = $('#btn-buy');
  sel.style.display = owned(c.id) ? '' : 'none';
  buy.style.display = owned(c.id) ? 'none' : '';
  sel.textContent = data.carId === c.id ? '選択中' : 'この車に乗る';
  sel.disabled = data.carId === c.id;
  buy.disabled = data.money < c.price;
  buy.textContent = data.money < c.price ? '資金が足りない' : `¥${formatMoney(c.price)} で購入`;
}

$('#btn-select').addEventListener('click', () => {
  data.carId = selCarId; save(data); renderGarage(); audio.beep(880, 0.1, 0.14);
});
$('#btn-buy').addEventListener('click', () => {
  const c = CAR_BY_ID[selCarId];
  if (data.money < c.price || owned(c.id)) return;
  data.money -= c.price;
  data.owned.push(c.id);
  data.carId = c.id;
  save(data); renderGarage(); audio.beep(1320, 0.16, 0.16);
});

// ---------------------------------------------------------------- ステージ選択

let coursePurpose = 'free';   // 選んだあとに何を始めるか

/** コース定義から、そのコースの形だけを小さく描きます（走行データは要りません）。 */
function drawCourseShape(cv, course) {
  const g = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 240, h = cv.clientHeight || 76;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const [ax, az] = course.aspect ?? [1, 1];
  const pts = [];
  for (let i = 0; i <= 240; i++) {
    const a = (i / 240) * Math.PI * 2;
    let r = course.radius.base;
    for (const [amp, freq, phase] of course.radius.harmonics) r += amp * Math.sin(freq * a + phase);
    pts.push([Math.cos(a) * r * ax, Math.sin(a) * r * az]);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = 8;
  const sc = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
  const ox = (w - (maxX - minX) * sc) / 2 - minX * sc;
  const oy = (h - (maxY - minY) * sc) / 2 - minY * sc;

  g.beginPath();
  pts.forEach(([x, y], i) => {
    const px = x * sc + ox, py = y * sc + oy;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  });
  g.closePath();
  g.strokeStyle = 'rgba(6,10,18,.9)'; g.lineWidth = 5; g.stroke();
  g.strokeStyle = 'rgba(255,154,82,.85)'; g.lineWidth = 1.8; g.stroke();
}

function bestKey(courseId, carId) { return `${courseId}:${carId}`; }

function renderCourses() {
  const forTA = coursePurpose === 'ta';
  $('#course-title').textContent = forTA ? 'タイムアタック — ステージ選択' : 'フリーラン — ステージ選択';
  $('#course-sub').textContent = forTA ? '1周のベストラップに挑む' : '交通量のある湾岸を自由に流す';
  $('#course-list').innerHTML = COURSES.map((c) => {
    const best = data.bestLap[bestKey(c.id, data.carId)];
    return `<div class="course-card" tabindex="0" data-course="${c.id}">
      <div class="cc-place">${c.place}</div>
      <div class="cc-tag">${c.tag}</div>
      <div class="cc-name">${c.name}</div>
      <div class="cc-sum">${c.summary}</div>
      <canvas></canvas>
      <div class="cc-meta">
        <span>全長</span><b>${(c.length / 1000).toFixed(1)} km</b>
        <span class="cc-best">${best ? 'BEST ' + formatTime(best) : '記録なし'}</span>
      </div>
    </div>`;
  }).join('');
  $$('#course-list .course-card').forEach((el) => {
    const c = COURSE_BY_ID[el.dataset.course];
    requestAnimationFrame(() => drawCourseShape(el.querySelector('canvas'), c));
    el.addEventListener('click', () => {
      applyCourse(c.id);
      if (coursePurpose === 'ta') startTA(); else startFree();
    });
  });
}

/** コースを切り替え、HUD の地図も作り直します。 */
function applyCourse(id) {
  if (!game) return;
  game.setCourse(id);
  if (hud) hud.setTrack(game.track);
  data.courseId = id;
  save(data);
}

// ---------------------------------------------------------------- ストーリー

function renderStory() {
  $('#rival-list').innerHTML = RIVALS.map((r, i) => {
    const cleared = data.cleared.includes(r.id);
    const locked = i > data.storyStage;
    const car = CAR_BY_ID[r.carId];
    return `<div class="rival-card ${locked ? 'locked' : ''} ${cleared ? 'cleared' : ''}" data-rival="${r.id}">
      <div class="no">STAGE ${String(i + 1).padStart(2, '0')}</div>
      <div class="nm">${locked ? '？？？' : r.name}</div>
      <div class="tt">${locked ? '—' : r.title}</div>
      <div class="cr">${locked ? 'まだ出会っていない' : `${car.maker} ${car.name}<br>${car.chassis}`}</div>
    </div>`;
  }).join('');
  $$('#rival-list .rival-card').forEach((el) => el.addEventListener('click', () => {
    if (el.classList.contains('locked')) return;
    openBrief(el.dataset.rival);
  }));
}

let currentRival = null;

function openBrief(rivalId) {
  const r = RIVALS.find((x) => x.id === rivalId);
  currentRival = r;
  const rc = CAR_BY_ID[r.carId];
  const mc = CAR_BY_ID[data.carId];
  const eff = applyTune(mc, tuneOf(data.carId));
  const rEff = applyTune(rc, r.tune);

  const rc2 = COURSE_BY_ID[r.courseId] || COURSE_BY_ID[DEFAULT_COURSE];
  $('#brief-title').textContent = `STAGE ${RIVALS.indexOf(r) + 1} — ${rc2.name}（${(rc2.length / 1000).toFixed(1)}km）`;
  $('#brief-name').textContent = r.name;
  $('#brief-subtitle').textContent = r.title;
  $('#brief-car').innerHTML =
    `${rc.maker} ${rc.name}<br>${rc.chassis} / ${rc.layout}<br>` +
    `約${Math.round(rEff.power)}ps · ${Math.round(rEff.mass)}kg`;
  $('#brief-quote').textContent = r.intro;
  $('#brief-mycar').innerHTML = `${mc.maker} ${mc.name}<br>${mc.chassis} / ${mc.layout}`;
  $('#brief-mystats').innerHTML =
    `出力 ${Math.round(eff.power)} ps ／ 車重 ${Math.round(eff.mass)} kg<br>` +
    `パワーウェイトレシオ ${(eff.mass / eff.power).toFixed(2)} kg/ps`;

  const myPW = eff.mass / eff.power, rPW = rEff.mass / rEff.power;
  $('#brief-warn').textContent =
    myPW > rPW * 1.22 ? '※ 相手のほうが明らかに速い。ガレージでチューンしたほうがいい。'
      : myPW > rPW * 1.05 ? '※ スペックは相手がやや上。スリップストリームを使え。'
        : '※ スペックはこちらが上。あとは腕の勝負。';
  show('brief');
}

$('#brief-start').addEventListener('click', () => startBattle(currentRival));

// ---------------------------------------------------------------- モード開始

let mode = null;

function playerTune() { return tuneOf(data.carId); }

function preparePlayer() {
  game.setPlayerCar(data.carId, playerTune(), colorOf(data.carId));
}

function startBattle(rival) {
  mode = 'battle';
  applyCourse(rival.courseId || DEFAULT_COURSE);
  preparePlayer();
  game.setRival(rival);
  const startS = game.track.length * 0.12;
  game.start('battle', { startS, rollingStart: true });
  hud.setBattle(true, 'YOU', rival.name);
  hud.message('READY', rival.intro, 2400);
  hideAll();
  showFirstHint();
  audio.resume();
}

function startFree() {
  mode = 'free';
  preparePlayer();
  game.setRival(null);
  game.start('free', { startS: 0, rollingStart: true });
  hud.setBattle(false);
  hud.message(game.course.name, `一周 ${(game.track.length / 1000).toFixed(1)} km`, 2400);
  hideAll();
  showFirstHint();
  audio.resume();
}

function startTA() {
  mode = 'ta';
  preparePlayer();
  game.setRival(null);
  game.start('timeattack', {
    startS: 0, rollingStart: false,
    bestLap: data.bestLap[bestKey(game.course.id, data.carId)] ?? Infinity,
  });
  hud.setBattle(false);
  hud.message(game.course.name, `1周 ${(game.track.length / 1000).toFixed(1)} km`, 2200);
  hideAll();
  audio.resume();
}

function restart() {
  if (mode === 'battle') startBattle(currentRival);
  else if (mode === 'free') startFree();
  else if (mode === 'ta') startTA();
}

// ---------------------------------------------------------------- リザルト

function showResult(result, state) {
  const win = result === 'win';
  $('#res-head').textContent = win ? 'WIN' : 'LOSE';
  $('#res-head').className = `res-head ${win ? 'win' : 'lose'}`;

  let reward = 0;
  let quote = '';
  if (mode === 'battle' && currentRival) {
    quote = win ? currentRival.win : currentRival.lose;
    if (win) {
      reward = currentRival.reward;
      if (!data.cleared.includes(currentRival.id)) {
        data.cleared.push(currentRival.id);
        const idx = RIVALS.indexOf(currentRival);
        data.storyStage = Math.max(data.storyStage, idx + 1);
      } else {
        reward = Math.round(reward * 0.35); // 再戦は控えめ
      }
    } else {
      reward = 120000;
    }
  } else {
    reward = Math.round(state.distance * 12 + state.topSpeed * 900);
    quote = `走行距離 ${(state.distance / 1000).toFixed(2)} km`;
  }
  data.money += reward;
  data.bestTop = Math.max(data.bestTop, Math.round(state.topSpeed));
  if (state.bestLap < Infinity) {
    const key = bestKey(game.course.id, data.carId);
    data.bestLap[key] = Math.min(data.bestLap[key] ?? Infinity, state.bestLap);
  }
  save(data);

  $('#res-quote').textContent = quote;
  $('#res-stats').innerHTML = [
    ['最高速', `${Math.round(state.topSpeed)} km/h`],
    ['走行距離', `${(state.distance / 1000).toFixed(2)} km`],
    ['経過時間', `${state.elapsed.toFixed(1)} 秒`],
    ['ベストラップ', state.bestLap < Infinity ? formatTime(state.bestLap) : '—'],
    ['獲得金額', `¥${formatMoney(reward)}`],
    ['所持金', `¥${formatMoney(data.money)}`],
  ].map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');

  const next = $('#res-next');
  const hasNext = mode === 'battle' && win && data.storyStage < RIVALS.length;
  next.querySelector('b').textContent = hasNext ? '次のライバルへ' : 'ストーリーへ';
  next.onclick = () => show('story');
  show('result');
}

$('#res-retry').addEventListener('click', () => restart());
$('#res-title').addEventListener('click', () => show('title'));

// ---------------------------------------------------------------- ポーズ

function togglePause(force) {
  if (current !== 'none' && current !== 'pause') return;
  paused = force !== undefined ? force : !paused;
  if (paused) {
    $('#pz-camlabel').textContent = CAM_MODES[game.camMode].label;
    show('pause');
  } else {
    hideAll();
  }
}
$('#pz-resume').addEventListener('click', () => togglePause(false));
$('#pz-restart').addEventListener('click', () => { paused = false; restart(); });
$('#pz-camera').addEventListener('click', () => {
  $('#pz-camlabel').textContent = game.cycleCamera();
  data.settings.cam = game.userCamMode;
  save(data);
});
$('#pz-finish').addEventListener('click', () => {
  paused = false;
  hideAll();
  game.finish(mode === 'battle' ? (game.state.gap > 0 ? 'win' : 'lose') : 'win');
});
$('#pz-quit').addEventListener('click', () => { paused = false; show('title'); });

// ---------------------------------------------------------------- 設定

function syncSettings() {
  $('#set-bloom').checked = data.settings.bloom;
  $('#set-sound').checked = data.settings.sound;
  $('#set-at').checked = data.settings.at;
  $('#set-assist').checked = data.settings.assist !== false;
  $('#set-quality').value = data.settings.quality;
  $('#set-touch').checked = !$('#touch').classList.contains('hidden');
}
$('#set-bloom').addEventListener('change', (e) => {
  data.settings.bloom = e.target.checked; game.setBloom(e.target.checked); save(data);
});
$('#set-sound').addEventListener('change', (e) => {
  data.settings.sound = e.target.checked; audio.resume(); audio.setEnabled(e.target.checked); save(data);
});
$('#set-at').addEventListener('change', (e) => {
  data.settings.at = e.target.checked; game.settings.at = e.target.checked; save(data);
});
$('#set-assist').addEventListener('change', (e) => {
  data.settings.assist = e.target.checked;
  game.settings.assist = e.target.checked;
  save(data);
});
$('#set-quality').addEventListener('change', (e) => {
  data.settings.quality = e.target.value;
  game.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, e.target.value === 'low' ? 1 : 2));
  save(data);
});
$('#set-touch').addEventListener('change', (e) => {
  $('#touch').classList.toggle('hidden', !e.target.checked);
});
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('セーブデータを消去します。よろしいですか？')) return;
  data = resetSave();
  selCarId = data.carId;
  show('title');
});

// ---------------------------------------------------------------- 起動

$$('[data-go]').forEach((b) => b.addEventListener('click', () => {
  const go = b.dataset.go;
  audio.resume();
  if (go === 'free' || go === 'ta') { coursePurpose = go; show('course'); return; }
  show(go);
}));

input.onAction = (code) => {
  if (code === 'Escape') {
    if (current !== 'none' && current !== 'pause' && current !== 'title' && current !== 'loading') {
      const back = $(`#scr-${current} .back`);
      if (back) { back.click(); return; }
    }
    togglePause();
    return;
  }
  if (current !== 'none') { menuKey(code); return; }
  if (code === 'KeyC') {
    hud.message(game.cycleCamera(), '', 900);
    data.settings.cam = game.userCamMode;
    save(data);
  }
  if (code === 'KeyR') restart();
};

function onGameEvent(type, payload) {
  if (type === 'count') hud.message(String(payload), '', 900);
  if (type === 'go') hud.message('GO', '', 900);
  if (type === 'lap') {
    const isBest = payload.time <= payload.best;
    hud.message(isBest ? 'BEST LAP' : 'LAP', formatTime(payload.time), 2200);
    if (mode === 'ta') {
      const key = bestKey(game.course.id, data.carId);
      data.bestLap[key] = Math.min(data.bestLap[key] ?? Infinity, payload.best);
      save(data);
    }
  }
  if (type === 'crash' && payload > 0.55) hud.message('CRASH', '', 700);
  if (type === 'overtake') {
    hud.message(payload.by === 'player' ? 'OVERTAKE' : 'PASSED', '', 1100);
    audio.beep(payload.by === 'player' ? 1180 : 420, 0.12, 0.12);
  }
  if (type === 'danger') document.getElementById('hud').classList.toggle('danger', payload);
  if (type === 'finish') {
    setTimeout(() => showResult(payload.result, payload.state), 900);
    hud.message(payload.result === 'win' ? 'WIN' : 'LOSE', '', 2000);
  }
}

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (game) {
    const inGame = (current === 'none') && !paused;
    if (inGame) {
      if (!game.state.finished && game.kind !== 'battle') $('#hud').classList.remove('danger');
      const s = input.sample(dt);
      game.update(dt, s, data.settings.sound ? audio : null);
      hud.update(dt, game.hudState(data.money));
      const v = game.player.vehicle;
      $('#speedvignette').style.opacity = String(clamp((v.speedKmh - 130) / 150, 0, 1));
    } else if (game.demo && current !== 'loading') {
      game.update(dt, NEUTRAL, null);
    }
    if (current !== 'loading') game.render();
  }
  renderPreview();
}

async function boot() {
  const canvas = $('#scene');
  $('#load-text').textContent = '湾岸を生成しています…';
  await new Promise((r) => setTimeout(r, 30));

  game = new Game(canvas, {
    settings: { ...data.settings },
    courseId: data.courseId || DEFAULT_COURSE,
    onEvent: onGameEvent,
  });
  $('#load-text').textContent = 'マシンを組み立てています…';
  const ver = $('#build-ver'); if (ver) ver.textContent = VERSION;
  await new Promise((r) => setTimeout(r, 30));

  if (!data.owned.includes(data.carId)) data.carId = data.owned[0] || 's15';
  game.userCamMode = data.settings.cam ?? 0;
  preparePlayer();
  game.start('free', { startS: game.track.length * 0.62, rollingStart: true });

  hud = new HUD(document.getElementById('hud'), game.track);
  input.bindTouch(document);
  if ('ontouchstart' in window) $('#touch').classList.remove('hidden');

  audio.init();
  audio.setEnabled(data.settings.sound);
  window.addEventListener('pointerdown', () => audio.resume(), { once: true });
  window.addEventListener('keydown', () => audio.resume(), { once: true });

  if (location.search.includes('debug')) window.__game = game;

  // タイトル画面でも背景として走らせておく（デモ走行）
  show('title');
  requestAnimationFrame(loop);
}

boot().catch((e) => {
  console.error(e);
  $('#load-text').textContent = '起動に失敗しました: ' + e.message;
});
