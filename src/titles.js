/**
 * 称号。走行の記録から自動で付きます。
 *
 * フリーランは走っても何も残らないので、積み上がるものを作ります。
 * 条件はすべて save.js の stats から判定できるものだけにしてあります。
 */
export const TITLES = [
  { id: 'first-run', name: '初走行', desc: '湾岸を走った', test: (s) => s.dist > 1000 },
  { id: 'commuter', name: '通い慣れた道', desc: '通算100km', test: (s) => s.dist > 100000 },
  { id: 'regular', name: '湾岸の常連', desc: '通算500km', test: (s) => s.dist > 500000 },
  { id: 'nightlife', name: '夜通し', desc: '通算1000km', test: (s) => s.dist > 1000000 },

  { id: 'courier', name: '運び屋', desc: '依頼を5件こなした', test: (s) => s.jobs >= 5 },
  { id: 'courier2', name: '腕のいい運び屋', desc: '依頼を25件こなした', test: (s) => s.jobs >= 25 },
  { id: 'careful', name: '無事故無違反', desc: '依頼を10件こなして、一度も連行されていない',
    test: (s) => s.jobs >= 10 && s.busted === 0 },

  { id: 'runner', name: '逃げ足', desc: '高速隊を3回振り切った', test: (s) => s.escapes >= 3 },
  { id: 'ghost', name: '影も踏ませない', desc: '高速隊を15回振り切った', test: (s) => s.escapes >= 15 },
  { id: 'most-wanted', name: '手配中', desc: '手配度3まで上がった', test: (s) => s.maxWanted >= 3 },
  { id: 'reckless', name: '赤信号は止まれ', desc: '信号無視20回', test: (s) => s.reds >= 20 },

  { id: 'wanderer', name: '寄り道', desc: 'PAに10回立ち寄った', test: (s) => s.paVisits >= 10 },
  { id: 'sunrise', name: '夜明けまで', desc: '空が明けるまで走りきった', test: (s) => s.dawns >= 1 },
  { id: 'sunrise3', name: '朝がくるまで', desc: '夜明けまで3回走りきった', test: (s) => s.dawns >= 3 },
];

/** 記録から、新しく付いた称号を返します。 */
export function newTitles(stats, have) {
  const owned = new Set(have || []);
  return TITLES.filter((t) => !owned.has(t.id) && t.test(stats));
}
