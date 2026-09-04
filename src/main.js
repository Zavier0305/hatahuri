import * as THREE from 'three';
import { Game, CAM_MODES } from './game.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { CARS, CAR_BY_ID } from './cars.js';
import { RIVALS } from './story.js';
import { load, save, resetSave, emptyTune } from './save.js';
import { applyTune } from './vehicle.js';
import { buildCar } from './carModel.js';
import { formatMoney, formatTime, clamp, KMH } from './util.js';

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
  if (id === 'garage') renderGarage();
  if (id === 'story') renderStory();
  if (id === 'settings') syncSettings();
}

function hideAll() { show('none'); }

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
  const key = new THREE.DirectionalLight(0xfff0dd, 1.5);
  key.position.set(4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x5ec8ff, 1.9);
  rim.position.set(-5, 3, -6); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xff9a4a, 0.7);
  fill.position.set(2, 1.2, -6); scene.add(fill);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6.4, 48),
    new THREE.MeshStandardMaterial({ color: 0x0a0e15, roughness: 0.42, metalness: 0.45 })
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

  $('#brief-title').textContent = `STAGE ${RIVALS.indexOf(r) + 1}`;
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
  preparePlayer();
  game.setRival(rival);
  const startS = game.track.length * 0.12;
  game.start('battle', { startS, rollingStart: true });
  hud.setBattle(true, 'YOU', rival.name);
  hud.message('READY', rival.intro, 2400);
  hideAll();
  audio.resume();
}

function startFree() {
  mode = 'free';
  preparePlayer();
  game.setRival(null);
  game.start('free', { startS: 0, rollingStart: true });
  hud.setBattle(false);
  hud.message('FREE RUN', '湾岸線 一周 ' + (game.track.length / 1000).toFixed(1) + ' km', 2200);
  hideAll();
  audio.resume();
}

function startTA() {
  mode = 'ta';
  preparePlayer();
  game.setRival(null);
  game.start('timeattack', {
    startS: 0, rollingStart: false,
    bestLap: data.bestLap[data.carId] ?? Infinity,
  });
  hud.setBattle(false);
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
    const prev = data.bestLap[data.carId] ?? Infinity;
    data.bestLap[data.carId] = Math.min(prev, state.bestLap);
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
  if (go === 'free') return startFree();
  if (go === 'ta') return startTA();
  show(go);
}));

input.onAction = (code) => {
  if (code === 'Escape') { togglePause(); return; }
  if (current !== 'none') return;
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
      data.bestLap[data.carId] = Math.min(data.bestLap[data.carId] ?? Infinity, payload.best);
      save(data);
    }
  }
  if (type === 'crash' && payload > 0.55) hud.message('CRASH', '', 700);
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
      const s = input.sample(dt);
      game.update(dt, s, data.settings.sound ? audio : null);
      hud.update(dt, game.hudState(data.money));
      const v = game.player.vehicle;
      $('#speedvignette').style.opacity = String(clamp((v.speedKmh - 160) / 190, 0, 0.85));
    } else if (game.demo && current !== 'loading') {
      game.update(dt, NEUTRAL, null);
    }
    if (current !== 'loading') game.render();
  }
  renderPreview();
}

async function boot() {
  const canvas = $('#scene');
  $('#load-text').textContent = 'コースを生成しています…';
  await new Promise((r) => setTimeout(r, 30));

  game = new Game(canvas, {
    settings: { ...data.settings },
    onEvent: onGameEvent,
  });
  $('#load-text').textContent = 'マシンを組み立てています…';
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
