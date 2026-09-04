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
  hintSeen: false,           // 初回の操作ガイドを見たか
  settings: { bloom: true, sound: true, at: true, assist: true, quality: 'high', cam: 0 },
};

export const emptyTune = () => ({ power: 0, weight: 0, tire: 0, aero: 0, gear: 0, turbo: 0 });

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT);
    const d = JSON.parse(raw);
    return { ...structuredClone(DEFAULT), ...d, settings: { ...DEFAULT.settings, ...(d.settings || {}) } };
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
