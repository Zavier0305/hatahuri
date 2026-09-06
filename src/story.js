// ストーリーモードの対戦相手。すべてオリジナルの登場人物です。
//
// 舞台は東京湾岸、深夜2時から夜が明けるまでのあいだ。
// 各ステージのセリフは、勝ったとき／負けたときで別のものが出ます。

const T = (power, weight, tire, aero, gear, turbo) => ({ power, weight, tire, aero, gear, turbo });

export const RIVALS = [
  {
    id: 'r1', name: '新島 悠', title: '深夜の新顔',
    carId: 's15', tune: T(1, 0, 1, 0, 0, 1), color: 0x2f6fd0,
    courseId: 'umihotaru',
    skill: 0.72, aggression: 0.55, reward: 900000,
    intro: '「湾岸って、まっすぐなだけなんでしょ？」',
    win: '「……なにあれ。真っ直ぐで、置いていかれた」',
    lose: '「ほらね。踏めば誰でも同じだって」',
  },
  {
    id: 'r2', name: '東雲 涼', title: 'ロータリーの狂犬',
    carId: 'fd3s', tune: T(2, 2, 2, 1, 1, 2), color: 0xd8d8d2,
    courseId: 'daikoku',
    skill: 0.78, aggression: 0.70, reward: 1400000,
    intro: '「軽いほうが勝つ。ここは直線だけの道じゃない」',
    win: '「重い車に、あんな入り方されるとはな」',
    lose: '「回して落として、また回す。それだけだよ」',
  },
  {
    id: 'r3', name: '桐生 剛', title: '湾岸の古株',
    carId: 'bnr32', tune: T(3, 2, 2, 2, 2, 2), color: 0x2b3a4a,
    courseId: 'bayshore',
    skill: 0.82, aggression: 0.66, reward: 2000000,
    intro: '「その車、まだ本気じゃないな。……見せてみろよ」',
    win: '「悪くない。次はもう手加減しない」',
    lose: '「10年おなじ道を走ってる。近道はないぞ」',
  },
  {
    id: 'r4', name: '影山 迅', title: '直6の亡霊',
    carId: 'jza80', tune: T(3, 2, 2, 2, 3, 3), color: 0xc03018,
    courseId: 'aqualine',
    skill: 0.84, aggression: 0.60, reward: 2600000,
    intro: '「280km/hから先は、車じゃなく人間の勝負だ」',
    win: '「……その速度で、まだ前を見ていられるのか」',
    lose: '「怖くなったろ。それが正常だよ」',
  },
  {
    id: 'r5', name: '白瀬 律', title: '無音の刺客',
    carId: 'na1', tune: T(4, 3, 3, 3, 2, 0), color: 0xe8c520,
    courseId: 'haneda',
    skill: 0.87, aggression: 0.52, reward: 3200000,
    intro: '「ターボの谷がない車は、嘘をつかない」',
    win: '「速いね。理屈じゃなく、速い」',
    lose: '「踏んだぶんだけ前へ出る。単純でしょう」',
  },
  {
    id: 'r6', name: '六車 岳', title: '四駆の暴力',
    carId: 'cp9a', tune: T(4, 3, 4, 4, 2, 4), color: 0xdadde2,
    courseId: 'daikoku',
    skill: 0.86, aggression: 0.80, reward: 3800000,
    intro: '「最高速なんか要らん。曲がるところで全部持っていく」',
    win: '「直線でここまで離されると、さすがに笑うわ」',
    lose: '「コーナーは俺の庭だ。覚えとけ」',
  },
  {
    id: 'r7', name: '三雲 遼', title: '完成された速さ',
    carId: 'bnr34', tune: T(5, 3, 4, 4, 3, 4), color: 0x8a9099,
    courseId: 'minatomirai',
    skill: 0.90, aggression: 0.64, reward: 4600000,
    intro: '「データ上、あなたより速い。それだけの話です」',
    win: '「……データにない走りだ。悔しいな」',
    lose: '「机上の計算どおりでした」',
  },
  {
    id: 'r8', name: '黒鳥 隼', title: '夜鷹（よたか）',
    carId: 'p930', tune: T(5, 4, 5, 5, 4, 5), color: 0x101318,
    courseId: 'aqualine',
    skill: 0.94, aggression: 0.68, reward: 6000000,
    intro: '「この道で俺より速いのは、あと一台だけだ」',
    win: '「あいつと同じ匂いがする。……行ってこい」',
    lose: '「まだ早い。もっと踏めるようになってから来い」',
  },
  {
    id: 'r9', name: '？？？', title: '群青（ぐんじょう）',
    carId: 's30z', tune: T(5, 5, 4, 3, 5, 5), color: 0x1b2733,
    courseId: 'grandtour',
    skill: 0.97, aggression: 0.72, reward: 12000000,
    intro: '「……」（テールランプだけが、白みはじめた空の下で待っている）',
    win: '「―――」（何も言わず、明けていく湾岸へ消えていった）',
    lose: '「―――」（追いつけない。空が明るくなる前に、見失った）',
  },
];
