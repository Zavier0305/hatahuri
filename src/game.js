import * as THREE from 'three';
import { EffectComposer } from 'three/addons/EffectComposer.js';
import { RenderPass } from 'three/addons/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/OutputPass.js';

import { clamp, lerp, damp, wrapAngle, formatTime, KMH, rng } from './util.js';
import { createTrack, buildRoad, ROAD, LANE_U } from './track.js';
import { buildSky, buildSea, buildStreetLights, buildCity, buildTunnels, buildSigns, buildBridges, buildPiers } from './scenery.js';
import { buildCar } from './carModel.js';
import { Vehicle, slipstreamFactor } from './vehicle.js';
import { RivalAI } from './ai.js';
import { Traffic } from './traffic.js';
import { CAR_BY_ID } from './cars.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

const CAM_MODES = [
  { id: 'chase', label: '追走', dist: 6.6, height: 2.15, fov: 62, look: 9 },
  { id: 'far', label: 'ロング', dist: 10.5, height: 3.4, fov: 58, look: 12 },
  { id: 'hood', label: 'ボンネット', dist: -0.35, height: 1.16, fov: 68, look: 22 },
  { id: 'cine', label: 'シネマ', dist: 8.2, height: 1.05, fov: 46, look: 14 },
];

/** 走行中の1台ぶん（物理＋見た目＋エフェクト）をまとめた入れ物 */
class Actor {
  constructor(spec, tune, scene, opts = {}) {
    this.vehicle = new Vehicle(spec, tune, opts);
    const built = buildCar(spec, { color: opts.color });
    this.mesh = built.root;
    this.built = built;
    this.mesh.rotation.order = 'YXZ';
    scene.add(this.mesh);

    // 接地感を出す偽の影
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.dims.W * 1.45, spec.dims.L * 1.12),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    scene.add(shadow);
    this.shadow = shadow;

    this.tmp = {};
    this.q = new THREE.Quaternion();
    this.qa = new THREE.Quaternion();
    this.basis = new THREE.Matrix4();
    this.left = new THREE.Vector3();
  }

  syncMesh(track) {
    const v = this.vehicle;
    const sm = track.sample(v.s, this.tmp);
    // 回転行列は右手系（X×Y=Z）である必要があります。
    // 進行方向を +Z、上を +Y に取ると、残る +X は「進行方向の左」になります。
    this.basis.makeBasis(this.left.copy(sm.lat).negate(), sm.up, sm.tan);
    this.q.setFromRotationMatrix(this.basis);
    this.q.multiply(this.qa.setFromAxisAngle(Y, wrapAngle(v.heading - sm.heading)));
    this.q.multiply(this.qa.setFromAxisAngle(X, v.pitch));
    this.q.multiply(this.qa.setFromAxisAngle(Z, v.roll));
    this.mesh.quaternion.copy(this.q);
    this.mesh.position.copy(v.pos);

    // ホイールの回転とステア
    for (const w of this.built.wheels) {
      w.spin.rotation.x -= (v.vx / v.spec.wheelR) * (1 / 60);
      if (w.front) w.pivot.rotation.y = v.steer;
    }
    // ブレーキランプ
    const on = v.input.brake > 0.05;
    for (const b of this.built.brakeLights) {
      b.material.emissiveIntensity = on ? 5.0 : 1.5;
    }
    this.shadow.position.set(v.pos.x, v.pos.y + 0.04, v.pos.z);
    this.shadow.quaternion.copy(this.q);
    this.shadow.rotateX(-Math.PI / 2);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    scene.remove(this.shadow);
  }
}

/** 粒子用の丸いスプライト（四角い点にならないように） */
function softDot(hard = 0.25) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(hard, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 火花・タイヤスモークなどの粒子 */
class Particles {
  constructor(scene, count, color, size, additive = true) {
    const pos = new Float32Array(count * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color, size, transparent: true, opacity: 0.9, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true, map: softDot(additive ? 0.15 : 0.05), fog: !additive,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.count = count;
    this.life = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.arr = g.attributes.position.array;
    this.cursor = 0;
    this.geo = g;
    for (let i = 0; i < count; i++) this.arr[i * 3 + 1] = -9999;
  }
  emit(p, v, life, spread) {
    const i = this.cursor++ % this.count;
    this.arr[i * 3] = p.x; this.arr[i * 3 + 1] = p.y; this.arr[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = v.y + Math.random() * spread * 0.6;
    this.vel[i * 3 + 2] = v.z + (Math.random() - 0.5) * spread;
    this.life[i] = life;
  }
  update(dt) {
    let alive = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      alive = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.arr[i * 3 + 1] = -9999; continue; }
      this.arr[i * 3] += this.vel[i * 3] * dt;
      this.arr[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.arr[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 9.0 * dt;
      this.vel[i * 3] *= 0.98;
      this.vel[i * 3 + 2] *= 0.98;
    }
    if (alive) this.geo.attributes.position.needsUpdate = true;
  }
}

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.settings = opts.settings || { bloom: true, quality: 'high', at: false };
    this.onEvent = opts.onEvent || (() => {});

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: this.settings.quality !== 'low', powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.quality === 'low' ? 1 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.55;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x080c17, 0.0019);

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 12000);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camMode = 0;
    this.shake = 0;

    // --- ライティング（夜なので控えめ＋発光で見せる）
    this.scene.add(new THREE.HemisphereLight(0x3d4f78, 0x14192a, 1.25));
    const moon = new THREE.DirectionalLight(0xb8cbf0, 1.05);
    moon.position.set(0.6, 1, -0.5);
    this.scene.add(moon);
    // 街の照り返し（夜でも車体の形が読めるようにする最低限の環境光）
    const bounce = new THREE.DirectionalLight(0xffb277, 0.45);
    bounce.position.set(-0.5, 0.25, 0.8);
    this.scene.add(bounce);
    this.scene.add(new THREE.AmbientLight(0x333f5c, 0.85));

    // --- コース
    this.track = createTrack(opts.seed ?? 20240);
    this.scene.add(buildRoad(this.track));
    this.sky = buildSky(this.scene);
    this.sea = buildSea(this.scene);
    buildPiers(this.track, this.scene);
    this.lights = buildStreetLights(this.track, this.scene);
    this.city = buildCity(this.track, this.scene, 99);
    buildTunnels(this.track, this.scene);
    buildSigns(this.track, this.scene);
    buildBridges(this.track, this.scene);

    this.traffic = new Traffic(this.track, this.scene, this.settings.quality === 'low' ? 20 : 34);

    // --- エフェクト
    this.sparks = new Particles(this.scene, 240, 0xffc266, 0.42);
    this.smoke = new Particles(this.scene, 220, 0xa8b0bd, 0.95, false);
    this.smoke.points.material.opacity = 0.16;

    // --- ヘッドライト（自車のみスポットライト）
    this.headSpot = new THREE.SpotLight(0xfff2d8, 90, 230, Math.PI * 0.20, 0.5, 1.1);
    this.headSpot.castShadow = false;
    this.scene.add(this.headSpot);
    this.scene.add(this.headSpot.target);

    this.setupComposer();

    this.player = null;
    this.rival = null;
    this.rivalAI = null;
    this.demo = false;        // メニュー背景の自動走行
    this.autoAI = null;
    this.mode = 'idle';
    this.state = {};
    this._acc = 0;
    this._tmpA = {};
    this._v3 = new THREE.Vector3();
    this._v3b = new THREE.Vector3();
    // カメラ計算専用（他と共有すると値が壊れるので必ず分けておく）
    this._camDir = new THREE.Vector3();
    this._camMix = new THREE.Vector3();
    this._camIdeal = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setupComposer() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, 0.62, 0.72, 0.72);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- セットアップ

  setPlayerCar(carId, tune, color) {
    if (this.player) this.player.dispose(this.scene);
    const spec = CAR_BY_ID[carId];
    this.player = new Actor(spec, tune, this.scene, { color });
    this.player.vehicle.name = 'YOU';
    this.autoAI = new RivalAI(this.player.vehicle, this.track, { skill: 0.80, aggression: 0.45 });
    return this.player;
  }

  /** メニュー中は自車をAIに走らせて、背景をライブ映像にします。 */
  setDemo(on) {
    this.demo = on;
    if (on) {
      this.camMode = CAM_MODES.findIndex((c) => c.id === 'cine');
      if (this.camMode < 0) this.camMode = 0;
      if (this.mode === 'idle' || this.mode === 'result') this.mode = 'racing';
    }
  }

  setRival(rivalDef) {
    if (this.rival) this.rival.dispose(this.scene);
    if (!rivalDef) { this.rival = null; this.rivalAI = null; return null; }
    const spec = CAR_BY_ID[rivalDef.carId];
    this.rival = new Actor(spec, rivalDef.tune, this.scene, { isAI: true, color: rivalDef.color, name: rivalDef.name });
    this.rivalAI = new RivalAI(this.rival.vehicle, this.track, {
      skill: rivalDef.skill, aggression: rivalDef.aggression,
    });
    this.rival.vehicle.name = rivalDef.name;
    return this.rival;
  }

  /** モード開始。kind: 'battle' | 'free' | 'timeattack' */
  start(kind, opts = {}) {
    const startS = opts.startS ?? 0;
    this.kind = kind;
    const pv = this.player.vehicle;
    pv.placeOnTrack(this.track, startS, LANE_U[1]);
    pv.gear = 1;
    if (this.rival) {
      this.rival.vehicle.placeOnTrack(this.track, startS + 4, LANE_U[0]);
      this.rival.vehicle.gear = 1;
    }
    this.state = {
      life: 1, rivalLife: 1, gap: 0, finished: false, result: null,
      startTime: performance.now(), lapStart: performance.now(),
      lapTime: 0, bestLap: opts.bestLap || Infinity, lastLap: 0,
      lapCount: 0, topSpeed: 0, distance: 0, elapsed: 0,
      countdown: kind === 'free' ? 0 : 3.2,
      rollingStart: opts.rollingStart ?? (kind !== 'timeattack'),
    };
    if (this.state.rollingStart) {
      const v0 = 78 / 3.6;
      pv.vx = v0; pv.gear = 4;
      if (this.rival) { this.rival.vehicle.vx = v0; this.rival.vehicle.gear = 4; }
    }
    this.traffic.density = opts.traffic ?? 1;
    this.mode = this.state.countdown > 0 ? 'countdown' : 'racing';
    this.camMode = opts.camMode ?? this.camMode;
  }

  cycleCamera() {
    this.camMode = (this.camMode + 1) % CAM_MODES.length;
    return CAM_MODES[this.camMode].label;
  }

  // ---------------------------------------------------------------- 当たり判定

  collideTraffic(actor, isPlayer) {
    const v = actor.vehicle;
    if (v.crashCooldown > 0) return 0;
    const half = v.spec.dims;
    const list = this.traffic.near(v.s, 40);
    for (const { car, rel } of list) {
      const dl = Math.abs(rel);
      if (dl > half.L * 0.5 + car.halfL) continue;
      const du = Math.abs(car.u - v.u);
      if (du > half.W * 0.5 + car.halfW) continue;
      // 接触
      const closing = Math.abs(v.vx - (car.oncoming ? -car.vx : car.vx));
      const severity = clamp(closing / 45, 0.18, 1);
      v.vx *= 1 - severity * 0.55;
      v.vy += (v.u > car.u ? 1 : -1) * (2 + severity * 7);
      v.yawRate = clamp(v.yawRate + (Math.random() - 0.5) * severity * 1.8, -3.2, 3.2);
      v.crashCooldown = 0.7;
      this.emitSparks(v, 26 * severity);
      this.shake = Math.max(this.shake, severity);
      return severity;
    }
    return 0;
  }

  collideCars() {
    if (!this.rival) return;
    const a = this.player.vehicle, b = this.rival.vehicle;
    const ds = a.s - b.s;
    const du = a.u - b.u;
    if (Math.abs(ds) > (a.spec.dims.L + b.spec.dims.L) * 0.5) return;
    if (Math.abs(du) > (a.spec.dims.W + b.spec.dims.W) * 0.5) return;
    const push = (a.spec.dims.W + b.spec.dims.W) * 0.5 - Math.abs(du);
    const dir = du >= 0 ? 1 : -1;
    a.vy += dir * push * 5.5;
    b.vy -= dir * push * 5.5;
    a.vx *= 0.985; b.vx *= 0.985;
    this.emitSparks(a, 6);
    this.shake = Math.max(this.shake, 0.28);
  }

  emitSparks(v, n) {
    const p = this._v3.copy(v.pos);
    p.y += 0.35;
    const fwd = this._v3b.set(Math.sin(v.heading), 0, Math.cos(v.heading));
    for (let i = 0; i < n; i++) {
      this.sparks.emit(
        p,
        { x: -fwd.x * (6 + Math.random() * 14), y: 2 + Math.random() * 4, z: -fwd.z * (6 + Math.random() * 14) },
        0.35 + Math.random() * 0.4,
        7
      );
    }
  }

  emitSmoke(actor) {
    const v = actor.vehicle;
    const slip = Math.max(v.slipRear, v.wheelSpin * 0.7);
    if (slip < 0.30 || Math.abs(v.vx) < 6) return;
    const back = -v.spec.dims.WB * 0.5;
    const cs = Math.cos(v.heading), sn = Math.sin(v.heading);
    for (const side of [-1, 1]) {
      const ox = side * v.spec.dims.W * 0.42;
      const p = this._v3.set(
        v.pos.x + sn * back + cs * ox,
        v.pos.y + 0.18,
        v.pos.z + cs * back - sn * ox
      );
      this.smoke.emit(p, { x: 0, y: 1.1, z: 0 }, 0.5 + slip * 0.7, 2.2);
    }
  }

  // ---------------------------------------------------------------- 更新

  update(dt, input, audio) {
    const st = this.state;
    if (this.mode === 'idle' || !this.player) return;
    dt = Math.min(dt, 0.05);

    const pv = this.player.vehicle;

    if (this.mode === 'countdown') {
      st.countdown -= dt;
      const n = Math.ceil(st.countdown);
      if (n !== st._lastCount) {
        st._lastCount = n;
        if (n > 0) { this.onEvent('count', n); audio && audio.beep(660, 0.14, 0.18); }
      }
      if (st.countdown <= 0) {
        this.mode = 'racing';
        st.startTime = performance.now();
        st.lapStart = performance.now();
        this.onEvent('go');
        audio && audio.beep(1320, 0.3, 0.22);
      }
      // カウントダウン中も惰性で進む
      pv.input.throttle = 0; pv.input.brake = 0; pv.input.steer = 0;
    }

    // --- 入力
    if (this.demo && this.mode === 'racing' && this.autoAI) {
      const obstacles = this.traffic.cars
        .filter((c) => c.active && !c.oncoming)
        .map((c) => ({ s: c.s, u: c.u, vx: c.vx }));
      this.autoAI.update(dt, obstacles, 0);
      if (pv.shiftTimer <= 0) {
        if (pv.rpm > pv.spec.redline * 0.95 && pv.gear < pv.maxGear) pv.shiftUp();
        else if (pv.rpm < pv.spec.redline * 0.44 && pv.gear > 1) pv.shiftDown();
      }
    } else if (this.mode === 'racing') {
      const s = input;
      pv.input.throttle = s.throttle;
      pv.input.brake = s.brake;
      pv.input.steer = -s.steer;   // 入力は右が＋、車両モデルは左が＋
      pv.input.handbrake = s.handbrake;
      if (this.settings.at) {
        if (pv.shiftTimer <= 0) {
          if (pv.rpm > pv.spec.redline * 0.955 && pv.gear < pv.maxGear) pv.shiftUp();
          else if (pv.rpm < pv.spec.redline * 0.42 && pv.gear > 1) pv.shiftDown();
        }
      } else {
        if (s.shiftUp) { if (pv.shiftUp()) audio && audio.beep(220, 0.05, 0.06); }
        if (s.shiftDown) { if (pv.shiftDown()) audio && audio.beep(180, 0.05, 0.06); }
      }
    }

    // --- ライバルAI
    if (this.rivalAI && this.mode === 'racing') {
      const obstacles = this.traffic.cars
        .filter((c) => c.active && !c.oncoming)
        .map((c) => ({ s: c.s, u: c.u, vx: c.vx }));
      obstacles.push({ s: pv.s, u: pv.u, vx: pv.vx });
      this.rivalAI.update(dt, obstacles, st.gap);
    } else if (this.rival) {
      const rv = this.rival.vehicle;
      rv.input.throttle = 0; rv.input.brake = 0; rv.input.steer = 0;
    }

    // --- スリップストリーム
    if (this.rival) {
      pv.slipstream = damp(pv.slipstream, slipstreamFactor(pv, this.rival.vehicle), 4, dt);
      this.rival.vehicle.slipstream = damp(this.rival.vehicle.slipstream, slipstreamFactor(this.rival.vehicle, pv), 4, dt);
    } else {
      pv.slipstream = damp(pv.slipstream, 0, 4, dt);
    }

    // --- 物理
    pv.update(dt);
    const wallHit = pv.resolveWalls(this.track, { outer: ROAD.halfRoad - 0.35, inner: ROAD.medianHalf + 0.25 });
    if (wallHit > 0.6) {
      this.emitSparks(pv, 14);
      this.shake = Math.max(this.shake, clamp(wallHit / 8, 0.1, 0.9));
      audio && audio.crash(clamp(wallHit / 10, 0.2, 1));
    }
    pv.snapToRoad(this.track);
    const crash = this.collideTraffic(this.player, true);
    if (crash > 0) {
      audio && audio.crash(crash);
      this.onEvent('crash', crash);
    }

    if (this.rival) {
      const rv = this.rival.vehicle;
      rv.update(dt);
      rv.resolveWalls(this.track, { outer: ROAD.halfRoad - 0.35, inner: ROAD.medianHalf + 0.25 });
      rv.snapToRoad(this.track);
      this.collideTraffic(this.rival, false);
      this.collideCars();
    }

    this.traffic.update(dt, pv.s, pv.u);
    this.emitSmoke(this.player);
    if (this.rival) this.emitSmoke(this.rival);
    this.sparks.update(dt);
    this.smoke.update(dt);

    // --- 記録
    if (this.mode === 'racing') {
      st.elapsed += dt;
      st.distance += Math.abs(pv.vx) * dt;
      st.topSpeed = Math.max(st.topSpeed, pv.speedKmh);
      st.lapTime = performance.now() - st.lapStart;

      // 周回判定（0地点をまたいだら1周）
      if (st._lastS !== undefined && pv.s < st._lastS - this.track.length * 0.5) {
        st.lapCount++;
        st.lastLap = st.lapTime;
        st.bestLap = Math.min(st.bestLap, st.lastLap);
        st.lapStart = performance.now();
        this.onEvent('lap', { lap: st.lapCount, time: st.lastLap, best: st.bestLap });
        // タイムアタックは1周で終了
        if (this.kind === 'timeattack') this.finish('win');
      }
      st._lastS = pv.s;
    }

    // --- バトル判定
    if (this.kind === 'battle' && this.rival && this.mode === 'racing' && !st.finished) {
      const L = this.track.length;
      let gap = pv.s - this.rival.vehicle.s;
      if (gap > L / 2) gap -= L;
      if (gap < -L / 2) gap += L;
      st.gap = gap;
      const drain = (g) => (0.018 + Math.pow(clamp(g / 220, 0, 1), 1.25) * 0.34) * dt;
      if (gap > 2) st.rivalLife -= drain(gap);
      else if (gap < -2) st.life -= drain(-gap);
      else { st.life = Math.min(1, st.life + dt * 0.012); st.rivalLife = Math.min(1, st.rivalLife + dt * 0.012); }

      if (st.rivalLife <= 0 || gap > 420) this.finish('win');
      else if (st.life <= 0 || gap < -420) this.finish('lose');
    }

    // --- 演出
    this.updateCamera(dt);
    this.updateEffects(dt);
    this.player.syncMesh(this.track);
    if (this.rival) this.rival.syncMesh(this.track);
    audio && audio.update(pv, dt, { inside: CAM_MODES[this.camMode].id === 'hood' });
  }

  finish(result) {
    if (this.state.finished) return;
    this.state.finished = true;
    this.state.result = result;
    this.mode = 'result';
    this.onEvent('finish', { result, state: this.state });
  }

  updateCamera(dt) {
    const v = this.player.vehicle;
    const cm = CAM_MODES[this.camMode];
    const speed = Math.abs(v.vx);
    const sm = this.track.sample(v.s, this._tmpA);

    // 車の向きではなく、少し進行方向へ寄せた向きを使うと落ち着いて見えます
    const carDir = this._camDir.set(Math.sin(v.heading), 0, Math.cos(v.heading)).normalize();
    const mixDir = this._camMix.copy(carDir).lerp(sm.tan, 0.35).normalize();

    const ideal = this._camIdeal.copy(v.pos)
      .addScaledVector(mixDir, -cm.dist)
      .addScaledVector(sm.up, cm.height);
    if (cm.id === 'cine') {
      ideal.addScaledVector(sm.lat, -4.5);
    }
    if (cm.id === 'hood') {
      ideal.copy(v.pos)
        .addScaledVector(carDir, cm.dist)
        .addScaledVector(sm.up, cm.height);
    }

    const follow = cm.id === 'hood' ? 40 : lerp(6.5, 11, clamp(speed / 80, 0, 1));
    this.camPos.lerp(ideal, 1 - Math.exp(-follow * dt));

    const lookTarget = this._camTarget.copy(v.pos)
      .addScaledVector(carDir, cm.look)
      .addScaledVector(sm.up, 0.9);
    this.camLook.lerp(lookTarget, 1 - Math.exp(-(cm.id === 'hood' ? 40 : 9) * dt));

    // 揺れ
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * 0.55 + clamp((speed - 55) / 90, 0, 1) * 0.045;
    this.camera.position.copy(this.camPos);
    if (sh > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * sh;
      this.camera.position.y += (Math.random() - 0.5) * sh;
      this.camera.position.z += (Math.random() - 0.5) * sh;
    }
    this.camera.up.copy(sm.up);
    this.camera.lookAt(this.camLook);

    const targetFov = cm.fov + clamp(speed / 90, 0, 1) * 20 + v.boost * 2;
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();

    // ヘッドライト
    this.headSpot.position.copy(v.pos).addScaledVector(sm.up, 0.62);
    this.headSpot.target.position.copy(v.pos)
      .addScaledVector(carDir, 42)
      .addScaledVector(sm.up, -0.4);
  }

  updateEffects(dt) {
    const v = this.player.vehicle;
    const tunnel = this.track.isTunnel(v.s);
    const targetFog = tunnel ? 0.0068 : 0.0019;
    this.scene.fog.density = damp(this.scene.fog.density, targetFog, 2.2, dt);
    const targetFogColor = tunnel ? 0x14171d : 0x080c17;
    this.scene.fog.color.lerp(new THREE.Color(targetFogColor), 1 - Math.exp(-2.2 * dt));

    // 航空障害灯の点滅
    if (this.city && this.city.reds) {
      const t = performance.now() * 0.001;
      this.city.reds.material.color.setRGB(1, 0.18, 0.12).multiplyScalar(0.35 + 0.65 * (Math.sin(t * 2.2) > 0 ? 1 : 0.25));
    }
  }

  render() {
    if (this.settings.bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  setBloom(on) {
    this.settings.bloom = on;
  }

  hudState(money) {
    const v = this.player.vehicle;
    const others = this.rival ? [{ s: this.rival.vehicle.s, color: '#ff5a4d' }] : [];
    const zoneNames = { bay: '湾岸', city: '市街', tunnel: 'トンネル', bridge: '橋梁' };
    return {
      player: v,
      others,
      money,
      timeText: this.kind === 'timeattack'
        ? formatTime(this.state.lapTime)
        : `${this.state.elapsed.toFixed(1)}s`,
      bestText: this.state.bestLap < Infinity ? `BEST ${formatTime(this.state.bestLap)}` : '',
      zoneText: `${zoneNames[this.track.zoneAt(v.s)] || '湾岸'}  ${(v.s / 1000).toFixed(1)}/${(this.track.length / 1000).toFixed(1)} km`,
    };
  }
}

export { CAM_MODES };
