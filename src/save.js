const KEY = 'tokyo-bay-early-morning-v1';

const DEFAULT = {
  money: 3200000,
  carId: 's15',
  owned: ['s15'],
  tunes: {},                 // carId -> {power,weight,tire,aero,gear,turbo}
  colors: {},                // carId -> 色(16進)
  storyStage: 0,
  cleared: [],
  bestLap: {},               // `${courseId}:${carId}` -> ms
  courseId: 'bayshore',      // 最後に選んだステージ
  bestTop: 0,                // 自己最高速[km/h]
  // 走行の積み上げ。フリーランに「残るもの」を作るための記録です。
  stats: {
    dist: 0,                 // 総走行距離[m]
    jobs: 0,                 // 依頼の達成数
    jobFail: 0,              // 依頼の失敗数
    escapes: 0,              // 高速隊を振り切った回数
    busted: 0,               // 連行された回数
    maxWanted: 0,            // 最高手配度
    reds: 0,                 // 信号無視の回数
    paVisits: 0,             // 立ち寄ったPAの数（延べ）
    dawns: 0,                // 夜明けまで走りきった回数
  },
  titles: [],                // 獲得した称号のid
  hintSeen: false,           // 初回の操作ガイドを見たか
  netName: '',               // オンラインでの表示名
  netRoom: '',               // 最後に使った合言葉
  netCourse: '',             // オンラインで走るステージ
  ghosts: {},                // コースごとの自己ベストの走り（ゴースト用）
  settings: { bloom: true, sound: true, at: true, assist: true, quality: 'high', cam: 0 },
};

export const emptyTune = () => ({ power: 0, weight: 0, tire: 0, aero: 0, gear: 0, turbo: 0 });

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT);
    const d = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT), ...d,
      settings: { ...DEFAULT.settings, ...(d.settings || {}) },
      // 古いセーブには stats が無いので、足りないものを補います
      stats: { ...structuredClone(DEFAULT.stats), ...(d.stats || {}) },
      titles: Array.isArray(d.titles) ? d.titles : [],
      ghosts: (d.ghosts && typeof d.ghosts === 'object') ? d.ghosts : {},
    };
  } catch (e) {
    return structuredClone(DEFAULT);
  }
}

export function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 保存できなくても続行 */ }
}

export function resetSave() {
  try { localStorage.removeItem(KEY); } catch (e) {}
  return structuredClone(DEFAULT);
}
