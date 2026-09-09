// ストーリーモードの対戦相手。すべてオリジナルの登場人物です。
//
// 舞台は東京湾岸、深夜2時から夜が明けるまでのあいだ。
// 各ステージのセリフは、勝ったとき／負けたときで別のものが出ます。
// 一度倒した相手に再戦を挑むと、また別の一言が出ます。

const T = (power, weight, tire, aero, gear, turbo) => ({ power, weight, tire, aero, gear, turbo });

/**
 * 章。ライバルを4つのまとまりに分けて、変わり目に幕間を出します。
 * 一本道に並べただけだと「名簿」にしか見えず、どこまで来たのかも分かりません。
 * from は、その章が始まるライバルの番号（0始まり）です。
 */
export const CHAPTERS = [
  {
    from: 0, title: '第一章　終電のあと',
    lead: '終電が消えると、湾岸に車が集まりはじめる。'
      + 'まだ名前もない連中ばかりだ。だが、ここで負けるなら先はない。',
  },
  {
    from: 4, title: '第二章　名前のある奴ら',
    lead: 'この道で名前を呼ばれる連中が出てくる。'
      + '速さの理屈も、走る理由も、ひとりひとり違う。',
  },
  {
    from: 9, title: '第三章　本気の連中',
    lead: '記録を持っている側の人間だ。'
      + 'ここから先は、車を仕上げていないと話にならない。',
  },
  {
    from: 13, title: '第四章　群青',
    lead: '空が白みはじめる時間。'
      + '「群青」と呼ばれる一台の話を、誰もが少しずつ違う形で語る。',
  },
];

export const RIVALS = [
  {
    id: 'r1', name: '新島 悠', title: '深夜の新顔',
    carId: 's15', tune: T(1, 0, 1, 0, 0, 1), color: 0x2f6fd0,
    courseId: 'umihotaru',
    skill: 0.72, aggression: 0.55, reward: 900000,
    intro: '「湾岸って、まっすぐなだけなんでしょ？」',
    win: '「……なにあれ。真っ直ぐで、置いていかれた」',
    lose: '「ほらね。踏めば誰でも同じだって」',
    rematch: '「また来たんだ。今度はこっちが慣れてる」',
  },
  {
    id: 'r2', name: '東雲 涼', title: 'ロータリーの狂犬',
    carId: 'fd3s', tune: T(2, 2, 2, 1, 1, 2), color: 0xd8d8d2,
    courseId: 'daikoku',
    skill: 0.78, aggression: 0.70, reward: 1400000,
    intro: '「軽いほうが勝つ。ここは直線だけの道じゃない」',
    win: '「重い車に、あんな入り方されるとはな」',
    lose: '「回して落として、また回す。それだけだよ」',
    rematch: '「懲りないな。いいよ、何度でも」',
  },
  {
    id: 'r2b', name: '鵜飼 千尋', title: '雨の日しか出ない女',
    carId: 'gc8', tune: T(2, 1, 3, 2, 1, 2), color: 0x1c4f8a,
    courseId: 'rainbay',
    skill: 0.80, aggression: 0.58, reward: 1700000,
    intro: '「晴れの日に速い人は、たくさんいるので」',
    win: '「濡れてても、あなたのほうが上でしたか」',
    lose: '「水の膜の厚さって、見れば分かるでしょう」',
    rematch: '「まだ降ってますよ。やめておけばいいのに」',
  },
  {
    id: 'r2c', name: '神代 悟', title: '一般道の主',
    carId: 's15', tune: T(3, 3, 3, 1, 2, 3), color: 0x9c3020,
    courseId: 'jam',
    skill: 0.81, aggression: 0.74, reward: 1900000,
    intro: '「高速でしか速くない奴は、ここでは遅い」',
    win: '「……信号のない道みたいに走るんだな、あんた」',
    lose: '「詰まった道の読み方は、教えられるものじゃない」',
    rematch: '「渋滞の隙間は、日によって違うぞ」',
  },
  {
    id: 'r3', name: '桐生 剛', title: '湾岸の古株',
    carId: 'bnr32', tune: T(3, 2, 2, 2, 2, 2), color: 0x2b3a4a,
    courseId: 'bayshore',
    skill: 0.82, aggression: 0.66, reward: 2000000,
    intro: '「その車、まだ本気じゃないな。……見せてみろよ」',
    win: '「悪くない。次はもう手加減しない」',
    lose: '「10年おなじ道を走ってる。近道はないぞ」',
    rematch: '「仕上げてきたか。少しは楽しめそうだ」',
  },
  {
    id: 'r3b', name: '逢坂 累', title: '二台目の亡霊',
    carId: 'jza80', tune: T(3, 3, 3, 2, 2, 3), color: 0x18202c,
    courseId: 'tatsumi',
    skill: 0.84, aggression: 0.62, reward: 2300000,
    intro: '「前の車は、この先の壁で終わった。だから同じ車に乗ってる」',
    win: '「……二台目も、あんたには届かないか」',
    lose: '「壊した車のぶんまで踏んでる。悪いな」',
    rematch: '「まだ壊してない。それだけは自慢できる」',
  },
  {
    id: 'r4', name: '影山 迅', title: '直6の亡霊',
    carId: 'jza80', tune: T(3, 2, 2, 2, 3, 3), color: 0xc03018,
    courseId: 'aqualine',
    skill: 0.85, aggression: 0.60, reward: 2600000,
    intro: '「280km/hから先は、車じゃなく人間の勝負だ」',
    win: '「……その速度で、まだ前を見ていられるのか」',
    lose: '「怖くなったろ。それが正常だよ」',
    rematch: '「慣れたか。慣れたころがいちばん危ない」',
  },
  {
    id: 'r5', name: '白瀬 律', title: '無音の刺客',
    carId: 'na1', tune: T(4, 3, 3, 3, 2, 0), color: 0xe8c520,
    courseId: 'haneda',
    skill: 0.87, aggression: 0.52, reward: 3200000,
    intro: '「ターボの谷がない車は、嘘をつかない」',
    win: '「速いね。理屈じゃなく、速い」',
    lose: '「踏んだぶんだけ前へ出る。単純でしょう」',
    rematch: '「同じ相手と二度走るの、嫌いじゃないです」',
  },
  {
    id: 'r5b', name: '火野 蘭', title: '環状の女王',
    carId: 'cp9a', tune: T(4, 3, 4, 3, 2, 4), color: 0xd8455e,
    courseId: 'kawasaki',
    skill: 0.88, aggression: 0.82, reward: 3500000,
    intro: '「まっすぐが得意なんでしょ。じゃあ曲がるところで決めるわ」',
    win: '「……曲がるところで負けた。それがいちばん悔しい」',
    lose: '「ここ、何周したと思ってるの」',
    rematch: '「ライン、まだ覚えてないでしょ」',
  },
  {
    id: 'r6', name: '六車 岳', title: '四駆の暴力',
    carId: 'cp9a', tune: T(4, 3, 4, 4, 2, 4), color: 0xdadde2,
    courseId: 'daikoku',
    skill: 0.89, aggression: 0.80, reward: 3800000,
    intro: '「最高速なんか要らん。曲がるところで全部持っていく」',
    win: '「直線でここまで離されると、さすがに笑うわ」',
    lose: '「コーナーは俺の庭だ。覚えとけ」',
    rematch: '「庭の手入れは済ませてある」',
  },
  {
    id: 'r6b', name: '遠野 静', title: '記録係',
    carId: 'na1', tune: T(5, 4, 4, 3, 3, 0), color: 0xf2f4f7,
    courseId: 'makuhari',
    skill: 0.90, aggression: 0.50, reward: 4200000,
    intro: '「この区間の最速は、まだ私です。書き換えてみますか」',
    win: '「……書き換えられました。記録は、そういうものです」',
    lose: '「記録は運では出ません。何度でも出せます」',
    rematch: '「前回の数字、覚えていますか。私は覚えています」',
  },
  {
    id: 'r7', name: '三雲 遼', title: '完成された速さ',
    carId: 'bnr34', tune: T(5, 3, 4, 4, 3, 4), color: 0x8a9099,
    courseId: 'minatomirai',
    skill: 0.91, aggression: 0.64, reward: 4600000,
    intro: '「データ上、あなたより速い。それだけの話です」',
    win: '「……データにない走りだ。悔しいな」',
    lose: '「机上の計算どおりでした」',
    rematch: '「前回のデータは取ってあります。修正済みです」',
  },
  {
    id: 'r7b', name: '九条 玲', title: '湾岸の秒針',
    carId: 'bnr34', tune: T(5, 4, 5, 4, 4, 5), color: 0x101a2c,
    courseId: 'umihotaru',
    skill: 0.93, aggression: 0.70, reward: 5200000,
    intro: '「ここから料金所まで、私は何秒か言えます。あなたは？」',
    win: '「……秒が合わない。こんなことは初めてです」',
    lose: '「ほら、言ったとおりの秒でした」',
    rematch: '「今日の秒は、この前より短いですよ」',
  },
  {
    id: 'r8', name: '黒鳥 隼', title: '夜鷹（よたか）',
    carId: 'p930', tune: T(5, 4, 5, 5, 4, 5), color: 0x101318,
    courseId: 'aqualine',
    skill: 0.94, aggression: 0.68, reward: 6000000,
    intro: '「この道で俺より速いのは、あと一台だけだ」',
    win: '「あいつと同じ匂いがする。……行ってこい」',
    lose: '「まだ早い。もっと踏めるようになってから来い」',
    rematch: '「二度目だな。あいつは二度目を許さないぞ」',
  },
  {
    id: 'r8b', name: '白鷺 冴', title: '群青を知る者',
    carId: 'p930', tune: T(5, 5, 5, 5, 5, 5), color: 0x6a7078,
    courseId: 'grandtour',
    skill: 0.95, aggression: 0.60, reward: 8000000,
    intro: '「あれを追いかけて、私はこの車を三台潰しました」',
    win: '「……四台目は、あなたに任せます」',
    lose: '「まだ足りない。あれは、こんなものじゃない」',
    rematch: '「近づいてきましたね。あの色に」',
  },
  {
    id: 'r9', name: '？？？', title: '群青（ぐんじょう）',
    carId: 's30z', tune: T(5, 5, 4, 3, 5, 5), color: 0x1b2733,
    courseId: 'grandtour',
    skill: 0.97, aggression: 0.72, reward: 12000000,
    intro: '「……」（テールランプだけが、白みはじめた空の下で待っている）',
    win: '「―――」（何も言わず、明けていく湾岸へ消えていった）',
    lose: '「―――」（追いつけない。空が明るくなる前に、見失った）',
    rematch: '「……」（同じ場所で、同じように待っている）',
  },
];

/** その番号のライバルが属する章。 */
export function chapterOf(index) {
  let c = CHAPTERS[0];
  for (const ch of CHAPTERS) if (index >= ch.from) c = ch;
  return c;
}
