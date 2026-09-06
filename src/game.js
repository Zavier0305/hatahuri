import * as THREE from 'three';
import { EffectComposer } from 'three/addons/EffectComposer.js';
import { RenderPass } from 'three/addons/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/OutputPass.js';
import { clamp, lerp, damp, formatTime } from './util.js';
import { createTrack, buildRoad, ROAD, LANE_U } from './track.js';
import { COURSE_BY_ID, DEFAULT_COURSE } from './courses.js';
import { buildSky, buildSea, buildStreetLights, buildCity, buildTunnels, buildSigns, buildBridges, buildPiers, buildRoadside, buildEnvironment, buildLand } from './scenery.js';
import { slipstreamFactor } from './vehicle.js';
import { RivalAI } from './ai.js';
import { Traffic } from './traffic.js';
import { CAR_BY_ID } from './cars.js';
import { Actor, Particles, disposeTree } from './actors.js';
const CAM_MODES = [
  { id: 'chase', label: '追走', dist: 6.6, height: 2.15, fov: 62, look: 9 },
  { id: 'far', label: 'ロング', dist: 10.5, height: 3.4, fov: 58, look: 12 },
  // dist は「車の中心から前方へ何m」。以前は -0.35（＝中心より後ろ＝車内）で、
  // ボディの内側とドアミラーが画面の半分を埋めていました。
  // フロントガラス基部より前（+0.95m）へ出し、ボンネットの上から見ます。
  { id: 'hood', label: 'ボンネット', dist: 0.95, height: 1.12, fov: 68, look: 22 },
  { id: 'cine', label: 'シネマ', dist: 8.2, height: 1.05, fov: 46, look: 14 },
];

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
    this.scene.fog = new THREE.FogExp2(0x121b2e, 0.0021);

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 12000);
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camMode = 0;          // いま実際に使っている視点
    this.userCamMode = 0;      // プレイヤーが選んだ視点（デモで上書きしない）
    this.shake = 0;

    // --- ライティング（夜なので控えめ＋発光で見せる）
    // 明け方なので、空からの光がわずかに強く・青い
    this.scene.add(new THREE.HemisphereLight(0x4a628f, 0x171d2c, 1.5));
    const moon = new THREE.DirectionalLight(0xc2d2f2, 0.85);
    moon.position.set(-0.7, 0.9, -0.5);
    this.scene.add(moon);
    // 東の空からの薄明かり。夜明け側からだけ暖色が当たります。
    const dawn = new THREE.DirectionalLight(0xffa96a, 0.85);
    dawn.position.set(0.82, 0.18, 0.57);
    this.scene.add(dawn);
    this.scene.add(new THREE.AmbientLight(0x3a4868, 0.9));

    // --- コースに依存しないもの（空・海・環境マップ）は1度だけ作ります
    this.sky = buildSky(this.scene);
    // 夜明けを焼き込んだ環境マップ。ボディと路面に「映るもの」を与えます
    this.envMap = buildEnvironment(this.renderer, this.sky.sky);
    this.scene.environment = this.envMap;
    this.sea = buildSea(this.scene);

    // --- コースごとに作り直す部分は world にまとめ、切り替え時にまとめて捨てます
    this.world = null;
    this.track = null;
    this.course = null;
    this.traffic = null;
    this.wet = false;

    // --- 雨。降っているコースでだけ表示します。
    this.rain = (() => {
      const N = 700;
      const pos = new Float32Array(N * 2 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xb8cbe4, transparent: true, opacity: 0.20,
        depthWrite: false, fog: false,
      }));
      lines.frustumCulled = false;
      lines.renderOrder = 4;
      lines.visible = false;
      this.scene.add(lines);
      const off = new Float32Array(N * 3);
      // カメラのすぐ周りにだけ降らせます。遠くまで撒くと、後ろへ寝た筋が
      // 消失点から放射状に伸びて「ワープ」に見えてしまいます。
      for (let i = 0; i < N; i++) {
        off[i * 3] = (Math.random() - 0.5) * 30;
        off[i * 3 + 1] = Math.random() * 15;
        off[i * 3 + 2] = Math.random() * 22 - 8;
      }
      return { lines, geo, off, N, arr: geo.attributes.position.array };
    })();

    // --- エフェクト
    this.sparks = new Particles(this.scene, 240, 0xffc266, 0.42);
    this.smoke = new Particles(this.scene, 220, 0xa8b0bd, 0.7, false);
    this.smoke.points.material.opacity = 0.11;

    // --- ヘッドライト（自車のみスポットライト）
    this.headSpot = new THREE.SpotLight(0xfff8ec, 52, 210, Math.PI * 0.19, 0.55, 1.2);
    this.headSpot.castShadow = false;
    this.scene.add(this.headSpot);
    this.scene.add(this.headSpot.target);

    // 街灯そのものを光源にします。45mおきの灯りの下を通るたびにボディが明るくなる、
    // 首都高の夜そのものの見え方になります（追従する架空のライトでは出せません）。
    this.lampLights = [
      new THREE.PointLight(0xffd9a0, 0, 46, 1.7),
      new THREE.PointLight(0xffd9a0, 0, 46, 1.7),
      new THREE.PointLight(0xffd9a0, 0, 46, 1.7),
    ];
    for (const l of this.lampLights) this.scene.add(l);
    // 空からのごく弱い環境的な補助（輪郭が完全に消えないための保険）
    this.rimLight = new THREE.PointLight(0x88a8dd, 2.4, 22, 2.0);
    this.scene.add(this.rimLight);

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
    this._tmpB = {};
    this._tmpC = {};
    this._fogColor = new THREE.Color();
    this._v3 = new THREE.Vector3();
    this._v3b = new THREE.Vector3();
    // カメラ計算専用（他と共有すると値が壊れるので必ず分けておく）
    this._camDir = new THREE.Vector3();
    this._camMix = new THREE.Vector3();
    this._camIdeal = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    // 障害物リストは毎フレーム作り直さず、同じ配列とオブジェクトを詰め替えます
    this._obstacles = [];
    this._obstaclePool = [];
    this.setCourse(opts.courseId || DEFAULT_COURSE);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** コースを切り替えます。前のコースの地形・建物・交通は破棄します。 */
  setCourse(courseId) {
    const course = COURSE_BY_ID[courseId] || COURSE_BY_ID[DEFAULT_COURSE];
    if (this.course && this.course.id === course.id) return this.track;

    if (this.world) {
      this.scene.remove(this.world);
      disposeTree(this.world);
      this.world = null;
    }
    if (this.traffic) {
      this.scene.remove(this.traffic.group);
      disposeTree(this.traffic.group);
      this.traffic = null;
    }

    this.course = course;
    this.track = createTrack(course);

    const w = new THREE.Group();
    w.name = 'world';
    w.add(buildRoad(this.track));
    buildLand(this.track, w);
    buildPiers(this.track, w);
    this.lights = buildStreetLights(this.track, w);
    buildRoadside(this.track, w);
    this.city = buildCity(this.track, w, (course.seed ?? 1) + 99, course.cityDensity ?? 0.9);
    buildTunnels(this.track, w);
    buildSigns(this.track, w);
    buildBridges(this.track, w);
    this.scene.add(w);
    this.world = w;

    // 天候。濡れた路面はグリップが落ち、映り込みが強くなります。
    this.wet = !!course.wet;
    this.rain.lines.visible = this.wet;
    const roadMat = w.children[0] && w.children[0].userData.roadMat;
    if (roadMat) {
      // 濡れたアスファルトも「金属」ではありません。metalness を上げると
      // 反射が路面の色に染まってしまい、ただ明るい灰色の道になります。
      // metalness 0・粗さをごく低くすると、正面は暗いまま浅い角度でだけ
      // 強く映り込む（フレネル反射）＝濡れた路面そのものの見え方になります。
      roadMat.roughness = this.wet ? 0.10 : 0.60;
      // 乾いていてもアスファルトは金属ではありません。metalness を残すと
      // 拡散色が削られ、環境の色に染まった灰色の板になります。
      roadMat.metalness = 0.0;
      // 乾いた側の 0.55 は、根拠なく 0.75 へ上げて画が白っぽくなったので戻しました
      roadMat.envMapIntensity = this.wet ? 1.7 : 0.55;
      roadMat.color.setHex(this.wet ? 0x6e747e : 0xffffff);
    }
    this.scene.fog.density = this.wet ? 0.0042 : 0.0021;

    const base = this.settings.quality === 'low' ? 26 : 44;
    const count = clamp(Math.round(base * (course.traffic ?? 1)), 12, 96);
    this.traffic = new Traffic(this.track, this.scene, count, (course.seed ?? 1) + 4242);

    // 走行中の参照をコースに合わせて作り直します
    if (this.player) {
      this.player.vehicle.placeOnTrack(this.track, 0, LANE_U[1]);
      this.autoAI = new RivalAI(this.player.vehicle, this.track, { skill: 0.80, aggression: 0.45 });
      this.autoAI.gripScale = this.wet ? 0.78 : 1;
    }
    if (this.rivalAI) { this.rivalAI.track = this.track; this.rivalAI.gripScale = this.wet ? 0.78 : 1; }
    this.onEvent('course', course);
    return this.track;
  }

  setupComposer() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, 0.48, 0.66, 0.82);
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
      const cine = CAM_MODES.findIndex((c) => c.id === 'cine');
      this.camMode = cine < 0 ? 0 : cine;
      if (this.mode === 'idle' || this.mode === 'result') this.mode = 'racing';
    } else {
      this.camMode = this.userCamMode;   // 走行時は必ずプレイヤーの視点に戻す
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
    this.rivalAI.gripScale = this.wet ? 0.78 : 1;
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
    if (opts.camMode !== undefined) this.userCamMode = opts.camMode;
    this.camMode = this.userCamMode;
  }

  cycleCamera() {
    this.userCamMode = (this.userCamMode + 1) % CAM_MODES.length;
    this.camMode = this.userCamMode;
    return CAM_MODES[this.camMode].label;
  }

  // ---------------------------------------------------------------- 当たり判定

  /**
   * コース座標 (s, u) の上で車体を動かします。
   * 衝突でめり込んだぶんを押し戻すのに使います。
   */
  /**
   * AI に渡す障害物リストを、使い回しの配列へ詰め直します。
   * 毎フレーム filter/map で新しい配列とオブジェクトを作ると、
   * 交通量ぶんのゴミが毎秒数千個生まれてカクつきの原因になります。
   */
  buildObstacles(extra) {
    const out = this._obstacles;
    out.length = 0;
    let k = 0;
    for (const c of this.traffic.cars) {
      if (!c.active || c.oncoming) continue;
      let o = this._obstaclePool[k];
      if (!o) o = this._obstaclePool[k] = { s: 0, u: 0, vx: 0 };
      o.s = c.s; o.u = c.u; o.vx = c.vx;
      out.push(o);
      k++;
    }
    if (extra) {
      let o = this._obstaclePool[k];
      if (!o) o = this._obstaclePool[k] = { s: 0, u: 0, vx: 0 };
      o.s = extra.s; o.u = extra.u; o.vx = extra.vx;
      out.push(o);
    }
    return out;
  }

  moveOnTrack(v, ds, du) {
    v.s += ds;
    v.u += du;
    const sm = this.track.sample(v.s, this._tmpC);
    v.pos.copy(sm.pos).addScaledVector(sm.lat, v.u).addScaledVector(sm.up, 0.02);
    v.trackIndex = sm.index;
  }

  /**
   * 一般車との衝突。
   * 「重なりを検出したら、浅いほうの軸へ押し出して、運動量保存で速度を交換する」
   * という順序にしています。以前は当たった瞬間に一定割合だけ減速して 0.7 秒無敵に
   * していたため、車体が相手にめり込んだまますり抜けて見えていました。
   */
  collideTraffic(actor) {
    const v = actor.vehicle;
    const myHalfL = v.spec.dims.L * 0.5;
    const myHalfW = v.spec.dims.W * 0.5;
    const m1 = v.spec.mass;
    let worst = 0;

    for (const { car, rel } of this.traffic.near(v.s, 26)) {
      const penL = myHalfL + car.halfL - Math.abs(rel);
      if (penL <= 0) continue;
      const du = v.u - car.u;
      const penW = myHalfW + car.halfW - Math.abs(du);
      if (penW <= 0) continue;

      const m2 = car.mass;
      const otherVx = car.oncoming ? -car.vx : car.vx;

      if (penW < penL * 0.55) {
        // ---- 側面をこすった（車線変更でぶつけた場合など）
        const dir = du >= 0 ? 1 : -1;
        this.moveOnTrack(v, 0, dir * penW);
        const sev = clamp((Math.abs(v.vy) + 1.5) / 10, 0.08, 0.5);
        v.vy = dir * Math.abs(v.vy) * 0.25;
        v.yawRate = clamp(v.yawRate + dir * sev * 0.5, -3.2, 3.2);
        v.vx *= 1 - sev * 0.10;
        car.nudge = 0.5;
        car.targetU = clamp(car.targetU - dir * 0.7, -11, 11);
        worst = Math.max(worst, sev * 0.6);
      } else {
        // ---- 追突（または正面衝突）：1次元の非弾性衝突として解きます
        const dir = rel > 0 ? -1 : 1;          // 相手が前なら自分を後ろへ
        this.moveOnTrack(v, dir * penL, 0);
        const closing = Math.abs(v.vx - otherVx);
        const e = 0.18;                         // 反発係数（ほぼ潰れる）
        const v1 = (m1 * v.vx + m2 * otherVx + m2 * e * (otherVx - v.vx)) / (m1 + m2);
        const v2 = (m1 * v.vx + m2 * otherVx + m1 * e * (v.vx - otherVx)) / (m1 + m2);
        v.vx = v1;
        if (!car.oncoming) car.vx = Math.max(4, v2);
        car.nudge = 0.7;
        v.yawRate = clamp(v.yawRate + (Math.random() - 0.5) * clamp(closing / 30, 0, 1) * 1.4, -3.2, 3.2);
        worst = Math.max(worst, clamp(closing / 32, 0.12, 1));
      }
    }

    if (worst > 0 && v.crashCooldown <= 0) {
      v.crashCooldown = 0.35;                   // 演出（火花・音）の連打だけ抑えます
      this.emitSparks(v, 8 + 24 * worst);
      this.shake = Math.max(this.shake, worst);
      return worst;
    }
    return 0;
  }

  /** 自車とライバルの接触。こちらも押し出し＋運動量保存で解きます。 */
  collideCars() {
    if (!this.rival) return;
    const a = this.player.vehicle, b = this.rival.vehicle;
    const L = this.track.length;
    let ds = a.s - b.s;
    if (ds > L / 2) ds -= L;
    if (ds < -L / 2) ds += L;

    const penL = (a.spec.dims.L + b.spec.dims.L) * 0.5 - Math.abs(ds);
    if (penL <= 0) return;
    const du = a.u - b.u;
    const penW = (a.spec.dims.W + b.spec.dims.W) * 0.5 - Math.abs(du);
    if (penW <= 0) return;

    const ma = a.spec.mass, mb = b.spec.mass;
    const wa = mb / (ma + mb), wb = ma / (ma + mb);   // 軽いほうが大きく動く

    if (penW < penL * 0.55) {
      const dir = du >= 0 ? 1 : -1;
      this.moveOnTrack(a, 0, dir * penW * wa);
      this.moveOnTrack(b, 0, -dir * penW * wb);
      a.vy = dir * Math.abs(a.vy) * 0.3 + dir * 1.2;
      b.vy = -dir * Math.abs(b.vy) * 0.3 - dir * 1.2;
      a.vx *= 0.995; b.vx *= 0.995;
      this.shake = Math.max(this.shake, 0.18);
    } else {
      const dir = ds > 0 ? 1 : -1;
      this.moveOnTrack(a, dir * penL * wa, 0);
      this.moveOnTrack(b, -dir * penL * wb, 0);
      const e = 0.22;
      const va = (ma * a.vx + mb * b.vx + mb * e * (b.vx - a.vx)) / (ma + mb);
      const vb = (ma * a.vx + mb * b.vx + ma * e * (a.vx - b.vx)) / (ma + mb);
      a.vx = va; b.vx = vb;
      this.shake = Math.max(this.shake, 0.3);
    }
    if (a.crashCooldown <= 0) {
      a.crashCooldown = 0.25;
      this.emitSparks(a, 10);
    }
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

  /** アフターファイア。高過給でシフトアップした瞬間にマフラーから火が出ます。 */
  emitBackfire(actor) {
    const v = actor.vehicle;
    const cs = Math.cos(v.heading), sn = Math.sin(v.heading);
    const back = -v.spec.dims.L * 0.5 - 0.1;
    for (const side of [-1, 1]) {
      const ox = side * v.spec.dims.W * 0.24;
      const p = this._v3.set(
        v.pos.x + sn * back + cs * ox,
        v.pos.y + v.spec.dims.H * 0.19,
        v.pos.z + cs * back - sn * ox
      );
      for (let i = 0; i < 7; i++) {
        this.sparks.emit(
          p,
          { x: -sn * (7 + Math.random() * 9), y: 0.4 + Math.random(), z: -cs * (7 + Math.random() * 9) },
          0.10 + Math.random() * 0.13,
          3.2
        );
      }
    }
  }

  emitSmoke(actor) {
    const v = actor.vehicle;
    // 濡れた路面では、滑っていなくてもタイヤが水を巻き上げます
    // 濡れた路面の水しぶきは、高速のときだけ・まばらに。
    // 常時出すと、車の後ろに灰色の玉が浮いているように見えます。
    const spray = this.wet && Math.abs(v.vx) > 38 && Math.random() < 0.45
      ? clamp((Math.abs(v.vx) - 38) / 60, 0, 0.28) : 0;
    const slip = Math.max(v.slipRear, v.wheelSpin * 0.7) + spray;
    if (slip < 0.34 || Math.abs(v.vx) < 8) return;
    const back = -v.spec.dims.WB * 0.5;
    const cs = Math.cos(v.heading), sn = Math.sin(v.heading);
    for (const side of [-1, 1]) {
      const ox = side * v.spec.dims.W * 0.42;
      const p = this._v3.set(
        v.pos.x + sn * back + cs * ox,
        v.pos.y + 0.18,
        v.pos.z + cs * back - sn * ox
      );
      this.smoke.emit(p, { x: 0, y: this.wet ? 1.6 : 1.1, z: 0 }, (this.wet ? 0.20 : 0.5) + slip * 0.6, this.wet ? 2.6 : 2.2);
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
    // デモ中は自車を AI が運転するので、舵角の割り当ても機械側に切り替えます
    pv.autoSteer = this.demo;
    if (this.demo && this.mode === 'racing' && this.autoAI) {
      this.autoAI.update(dt, this.buildObstacles(null), 0);
      if (pv.shiftTimer <= 0) {
        if (pv.rpm > pv.spec.redline * 0.95 && pv.gear < pv.maxGear) pv.shiftUp();
        else if (pv.rpm < pv.spec.redline * 0.44 && pv.gear > 1) pv.shiftDown();
      }
    } else if (this.mode === 'racing') {
      const s = input;
      pv.input.throttle = s.throttle;
      pv.input.brake = s.brake;
      pv.input.steer = -s.steer;   // 入力は右が＋、車両モデルは左が＋
      pv.assist = this.settings.assist !== false;
      pv.input.handbrake = s.handbrake;
      if (this.settings.at) {
        if (pv.shiftTimer <= 0) {
          const boostBefore = pv.boost;
          if (pv.rpm > pv.spec.redline * 0.955 && pv.gear < pv.maxGear) {
            if (pv.shiftUp() && boostBefore > 0.55) {
              this.emitBackfire(this.player);
              audio && audio.blowoff(boostBefore);
            }
          } else if (pv.rpm < pv.spec.redline * 0.42 && pv.gear > 1) pv.shiftDown();
        }
      } else {
        if (s.shiftUp) {
          const boostBefore = pv.boost;
          if (pv.shiftUp()) {
            audio && audio.beep(220, 0.05, 0.06);
            if (boostBefore > 0.55) { this.emitBackfire(this.player); audio && audio.blowoff(boostBefore); }
          }
        }
        if (s.shiftDown) { if (pv.shiftDown()) audio && audio.beep(180, 0.05, 0.06); }
      }
    }

    // --- ライバルAI
    if (this.rivalAI && this.mode === 'racing') {
      this.rivalAI.update(dt, this.buildObstacles(pv), st.gap);
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
    // 補助が「どこへ戻すか」を決めます。いま自分がいる場所にいちばん近い車線の中心。
    // 元いた車線へ引き戻すのではなく近いほうへ寄せるので、車線変更の邪魔になりません。
    let lane = LANE_U[0];
    for (const u of LANE_U) if (Math.abs(pv.u - u) < Math.abs(pv.u - lane)) lane = u;
    // 追越車線の中心(-2.9)ちょうどに寄せると中央分離帯まで1mしかなく、
    // わずかな振れで擦り続けます。分離帯側だけ余裕を持たせます（AI と同じ扱い）。
    pv.laneU = clamp(lane, -10.6, -3.4);

    pv.update(dt, { wet: this.wet });
    const wallHit = pv.resolveWalls(this.track, { outer: ROAD.halfRoad - 0.35, inner: ROAD.medianHalf + 0.25 }, dt);
    if (wallHit > 1.5) {
      this.emitSparks(pv, 14);
      this.shake = Math.max(this.shake, clamp(wallHit / 12, 0.1, 0.9));
      audio && audio.crash(clamp(wallHit / 14, 0.2, 1));
    }
    pv.snapToRoad(this.track);
    const crash = this.collideTraffic(this.player);
    if (crash > 0) {
      audio && audio.crash(crash);
      this.onEvent('crash', crash);
    }

    if (this.rival) {
      const rv = this.rival.vehicle;
      rv.update(dt, { wet: this.wet });
      rv.resolveWalls(this.track, { outer: ROAD.halfRoad - 0.35, inner: ROAD.medianHalf + 0.25 }, dt);
      rv.snapToRoad(this.track);
      this.collideTraffic(this.rival);
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
      // 前後が入れ替わった瞬間を知らせます（自分がどちら側にいるかが分かりにくかったため）
      if (st._prevGap !== undefined) {
        if (st._prevGap <= 0 && gap > 1.5) this.onEvent('overtake', { by: 'player' });
        else if (st._prevGap >= 0 && gap < -1.5) this.onEvent('overtake', { by: 'rival' });
      }
      st._prevGap = gap;
      st.gap = gap;
      const drain = (g) => (0.018 + Math.pow(clamp(g / 220, 0, 1), 1.25) * 0.34) * dt;
      if (gap > 2) st.rivalLife -= drain(gap);
      else if (gap < -2) st.life -= drain(-gap);
      else { st.life = Math.min(1, st.life + dt * 0.012); st.rivalLife = Math.min(1, st.rivalLife + dt * 0.012); }

      // 残りが少なくなったら警告（HUD側で赤く点滅させます）
      const danger = st.life < 0.28;
      if (danger !== st._danger) { st._danger = danger; this.onEvent('danger', danger); }

      if (st.rivalLife <= 0 || gap > 420) this.finish('win');
      else if (st.life <= 0 || gap < -420) this.finish('lose');
    }

    // --- 演出
    this.updateCamera(dt);
    this.updateRain(dt);
    this.updateEffects(dt);
    this.player.syncMesh(this.track);
    if (this.rival) this.rival.syncMesh(this.track);
    audio && audio.update(pv, dt, {
      inside: CAM_MODES[this.camMode].id === 'hood',
      tunnel: this.track.isTunnel(pv.s),
    });
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
    const mixDir = this._camMix.copy(carDir).lerp(sm.tan, 0.18).normalize();

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

    // 高速でカメラが離れすぎると車の位置がつかめないので、速いほど強く追従させます
    const follow = cm.id === 'hood' ? 40 : lerp(9, 22, clamp(speed / 85, 0, 1));
    this.camPos.lerp(ideal, 1 - Math.exp(-follow * dt));

    // カメラが壁やビルにめり込まないよう、道路の内側・路面より上に押し戻します
    if (cm.id !== 'hood') {
      const pr = this.track.project(this.camPos, v.trackIndex);
      const maxU = ROAD.halfRoad - 1.0;
      const cu = clamp(pr.u, -maxU, maxU);
      const ch = clamp(pr.h, 0.75, 22);
      if (cu !== pr.u || ch !== pr.h) {
        const sm2 = this.track.sample(pr.s, this._tmpB);
        this.camPos.copy(sm2.pos).addScaledVector(sm2.lat, cu).addScaledVector(sm2.up, ch);
      }
    }

    const lookTarget = this._camTarget.copy(v.pos)
      .addScaledVector(carDir, cm.look)
      .addScaledVector(sm.up, 0.9);
    this.camLook.lerp(lookTarget, 1 - Math.exp(-(cm.id === 'hood' ? 40 : 9) * dt));

    // 揺れ
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * 0.55 + Math.pow(clamp((speed - 50) / 90, 0, 1), 1.6) * 0.075;
    this.camera.position.copy(this.camPos);
    if (sh > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * sh;
      this.camera.position.y += (Math.random() - 0.5) * sh;
      this.camera.position.z += (Math.random() - 0.5) * sh;
    }
    this.camera.up.copy(sm.up);
    this.camera.lookAt(this.camLook);

    const targetFov = cm.fov + Math.pow(clamp(speed / 92, 0, 1), 1.35) * 26 + v.boost * 2.5;
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();

    // 近くの街灯3本を実際の位置に置く（トンネル内は消して天井照明の色に寄せる）
    const LAMP_STEP = 45;
    const tunnel = this.track.isTunnel(v.s);
    const base = Math.round(v.s / LAMP_STEP);
    for (let k = 0; k < this.lampLights.length; k++) {
      const idx = base + k - 1;
      const light = this.lampLights[k];
      const side = ((idx % 2) + 2) % 2 === 0 ? -1 : 1;
      const lsm = this.track.sample(idx * LAMP_STEP, this._tmpB);
      light.position.copy(lsm.pos)
        .addScaledVector(lsm.lat, side * (ROAD.halfRoad - 0.8))
        .addScaledVector(lsm.up, 9.0);
      const d = Math.abs(idx * LAMP_STEP - v.s);
      light.intensity = tunnel ? 0 : clamp(1 - d / 60, 0, 1) * 190;
      light.color.setHex(0xffd9a0);
    }
    if (tunnel) {
      // トンネルの天井灯は 14m おきに左右へ交互に付いています（scenery.js と同じ間隔）。
      // 以前は「車の真上に1灯」だけを置き続けていたため、天井のその一点だけが
      // 白く焼き付き、ブルームで塊になって見えていました。
      // 屋外の街灯と同じように、実際の灯具の位置に置いて通り過ぎさせます。
      const TUNNEL_STEP = 14;
      const tb = Math.round(v.s / TUNNEL_STEP);
      for (let k = 0; k < this.lampLights.length; k++) {
        const idx = tb + k - 1;
        const light = this.lampLights[k];
        const side = ((idx % 2) + 2) % 2 === 0 ? -1 : 1;
        const lsm = this.track.sample(idx * TUNNEL_STEP, this._tmpB);
        light.position.copy(lsm.pos)
          .addScaledVector(lsm.lat, side * 6.5)
          .addScaledVector(lsm.up, 6.0);
        const d = Math.abs(idx * TUNNEL_STEP - v.s);
        light.intensity = clamp(1 - d / 24, 0, 1) * 52;
        light.color.setHex(0xfff2d8);
      }
    }
    this.rimLight.position.copy(v.pos).addScaledVector(carDir, -4.0).addScaledVector(sm.up, 3.2);

    // 車の下の影を、いちばん強い灯りの反対側へずらします。
    // 真下に固定した黒い楕円のままだと、街灯の下を通っても影が動かず、
    // 「地面に貼りついたシール」に見えます。
    let lamp = null, best = 0;
    for (const l of this.lampLights) if (l.intensity > best) { best = l.intensity; lamp = l; }
    for (const actor of [this.player, this.rival]) {
      if (!actor) continue;
      const av = actor.vehicle;
      actor.shadowOffset = actor.shadowOffset || new THREE.Vector2();
      // 振れ幅は控えめに、しかも時間で滑らかに追わせます。
      // 生の値をそのまま使うと、いちばん強い灯りが切り替わるたびに
      // 影が 3m 近く飛び、車から外れて見えました（実測で上限に張り付いていた）。
      let tx = 0, tz = 0;
      if (lamp && best > 1) {
        const dx = av.pos.x - lamp.position.x, dz = av.pos.z - lamp.position.z;
        const dy = Math.max(2.5, lamp.position.y - av.pos.y);
        const k = clamp(0.6 / dy, 0, 0.12);
        tx = clamp(dx * k, -1.0, 1.0);
        tz = clamp(dz * k, -1.0, 1.0);
      }
      actor.shadowOffset.set(damp(actor.shadowOffset.x, tx, 3.0, dt),
                             damp(actor.shadowOffset.y, tz, 3.0, dt));
    }

    // ヘッドライト。
    // 光源を車の中心に置いていたため、円錐が自分のボンネットを内側から照らし、
    // ボンネットが白く光っていました（実車では起きません）。灯具の位置＝
    // 車の先端へ出します。
    this.headSpot.position.copy(v.pos)
      .addScaledVector(carDir, v.spec.dims.L * 0.5 + 0.05)
      .addScaledVector(sm.up, 0.62);
    this.headSpot.target.position.copy(v.pos)
      .addScaledVector(carDir, 42)
      .addScaledVector(sm.up, -0.4);
  }

  /** 雨粒を更新します。落下に速度ぶんの流れを足すので、速いほど後ろへ寝ます。 */
  updateRain(dt) {
    if (!this.wet) return;
    const v = this.player.vehicle;
    const r = this.rain;
    const sm = this.track.sample(v.s, this._tmpB);
    const fwd = this._camDir.set(Math.sin(v.heading), 0, Math.cos(v.heading));
    const right = this._camMix.set(-Math.cos(v.heading), 0, Math.sin(v.heading));
    const speed = Math.abs(v.vx);
    // 1本の長さ：落下ぶん＋走行ぶん
    // 1本の長さ。走行ぶんに引っぱられて寝ますが、寝すぎないよう頭打ちにします。
    // 物理的には時速200kmの雨は水平近くまで寝ますが、そのまま描くと
    // 消失点から放射状に伸びて「ワープ」にしか見えません。
    // ここは絵づくりを優先して、ほぼ縦の短い筋に留めます。
    // 以前は1本1.7mほどあり、白く長い線が画面に散って「レンズの傷」に
    // 見えていました。短く・薄くして、路面の映り込みのほうを主役にします。
    const dy = -0.85 - speed * 0.0015;
    const dz = clamp(-0.15 - speed * 0.007, -0.6, -0.15);
    const a = r.arr;
    for (let i = 0; i < r.N; i++) {
      r.off[i * 3 + 1] -= (26 + speed * 0.4) * dt;
      r.off[i * 3 + 2] -= speed * dt * 0.55;
      if (r.off[i * 3 + 1] < -2) { r.off[i * 3 + 1] += 17; r.off[i * 3 + 2] = Math.random() * 22 - 8; }
      if (r.off[i * 3 + 2] < -9) r.off[i * 3 + 2] += 30;
      const ox = r.off[i * 3], oy = r.off[i * 3 + 1], oz = r.off[i * 3 + 2];
      const px = v.pos.x + right.x * ox + sm.up.x * oy + fwd.x * oz;
      const py = v.pos.y + right.y * ox + sm.up.y * oy + fwd.y * oz;
      const pz = v.pos.z + right.z * ox + sm.up.z * oy + fwd.z * oz;
      a[i * 6] = px; a[i * 6 + 1] = py; a[i * 6 + 2] = pz;
      a[i * 6 + 3] = px + fwd.x * dz;
      a[i * 6 + 4] = py + dy;
      a[i * 6 + 5] = pz + fwd.z * dz;
    }
    r.geo.attributes.position.needsUpdate = true;
  }

  updateEffects(dt) {
    const v = this.player.vehicle;
    const tunnel = this.track.isTunnel(v.s);
    const targetFog = tunnel ? 0.0068 : (this.wet ? 0.0042 : 0.0021);
    this.scene.fog.density = damp(this.scene.fog.density, targetFog, 2.2, dt);
    const targetFogColor = tunnel ? 0x181c24 : (this.wet ? 0x1c2230 : 0x121b2e);
    this.scene.fog.color.lerp(this._fogColor.setHex(targetFogColor), 1 - Math.exp(-2.2 * dt));

    // 航空障害灯の点滅
    if (this.city && this.city.reds) {
      const t = performance.now() * 0.001;
      this.city.reds.material.color.setRGB(1, 0.18, 0.12)
        .multiplyScalar(0.35 + 0.65 * (Math.sin(t * 2.2) > 0 ? 1 : 0.25));
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
      // バトル中の体力・車間。これを渡していなかったため、HUD の
      // updateBattle() が一度も呼ばれず、ゲージが100%・車間が0mのまま
      // 固まっていました（勝敗は内部で進むので、予兆なく負けて見える）。
      battle: this.kind === 'battle' && this.rival && !this.state.finished
        ? { life: this.state.life, rivalLife: this.state.rivalLife, gap: this.state.gap }
        : null,
      timeText: this.kind === 'timeattack'
        ? formatTime(this.state.lapTime)
        : `${this.state.elapsed.toFixed(1)}s`,
      bestText: this.state.bestLap < Infinity ? `BEST ${formatTime(this.state.bestLap)}` : '',
      wet: this.wet,
      zoneText: `${this.course.name}${this.wet ? '（雨）' : ''}  ${zoneNames[this.track.zoneAt(v.s)] || '湾岸'}  ${(v.s / 1000).toFixed(1)}/${(this.track.length / 1000).toFixed(1)} km`,
    };
  }
}

export { CAM_MODES };
