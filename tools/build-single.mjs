// 全モジュールを1枚のHTMLに束ねるビルドスクリプト。
// Artifact など「1ファイルしか置けない場所」で配布するために使います。
//   node tools/build-single.mjs <出力先> <three のベースURL>
// 例: node tools/build-single.mjs dist/wangan.html https://cdn.jsdelivr.net/npm/three@0.160.0
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'dist/tokyo-bay-early-morning.html';
const threeBase = process.argv[3] || 'https://cdn.jsdelivr.net/npm/three@0.160.0';

// 依存の順に並べます。新しいモジュールを足したらここにも追加してください
// （入れ忘れは下の検査で必ず落ちます）。
const ORDER = [
  'util', 'courses', 'cars', 'carModel', 'track', 'vehicle', 'actors', 'scenery',
  'ai', 'police', 'jobs', 'traffic', 'crossing', 'skid','net','remote','race','ghost', 'audio', 'input', 'hud', 'story', 'save', 'titles', 'game', 'main',
];

// ローカルの vendor/addons は平坦だが、npm 配布は postprocessing/ 配下にある
const ADDON_DIR = {
  'EffectComposer.js': 'postprocessing/',
  'RenderPass.js': 'postprocessing/',
  'UnrealBloomPass.js': 'postprocessing/',
  'OutputPass.js': 'postprocessing/',
  'ShaderPass.js': 'postprocessing/',
  'MaskPass.js': 'postprocessing/',
  'Pass.js': 'postprocessing/',
};

const externalImports = new Set();
const bodies = [];
const declared = new Map();   // 連結後は同じスコープに入るので、同名の宣言は致命的

for (const name of ORDER) {
  const src = fs.readFileSync(path.join('src', `${name}.js`), 'utf8');
  const kept = [];
  for (const line of src.split('\n')) {
    const im = line.match(/^import\s+.*?from\s+'([^']+)';\s*$/);
    if (im) {
      const spec = im[1];
      if (spec.startsWith('.')) {
        // ローカル依存は連結で解決します。ただし ORDER に入っていなければ
        // 実行時に「〜 is not defined」になるので、ここで止めます。
        const dep = spec.replace(/^\.\//, '').replace(/\.js$/, '');
        if (!ORDER.includes(dep)) {
          throw new Error(
            `src/${name}.js が src/${dep}.js を読み込んでいますが、ORDER に入っていません。` +
            'tools/build-single.mjs の ORDER に依存順で追加してください。'
          );
        }
        if (ORDER.indexOf(dep) > ORDER.indexOf(name)) {
          throw new Error(
            `依存の順序が逆です: src/${name}.js は src/${dep}.js より後に置く必要があります。`
          );
        }
        continue;
      }
      let fixed = line;
      if (spec.startsWith('three/addons/')) {
        const file = spec.slice('three/addons/'.length);
        fixed = line.replace(spec, `three/addons/${ADDON_DIR[file] ?? ''}${file}`);
      }
      externalImports.add(fixed.trim());
      continue;
    }
    if (/^import\s+/.test(line)) continue;
    const decl = line.match(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/);
    if (decl) {
      const prev = declared.get(decl[1]);
      if (prev) {
        throw new Error(
          `トップレベルの名前が衝突しています: "${decl[1]}" (src/${prev}.js と src/${name}.js)。` +
          '1ファイルに束ねると同じスコープに入り、実行時に SyntaxError になります。どちらかを改名してください。'
        );
      }
      declared.set(decl[1], name);
    }
    kept.push(
      line
        .replace(/^export\s+(const|let|var|function|class|async)\b/, '$1')
        .replace(/^export\s*\{[^}]*\};?\s*$/, '')
    );
  }
  bodies.push(`\n// ============================== src/${name}.js ==============================\n` + kept.join('\n'));
}

const css = fs.readFileSync(path.join('styles', 'main.css'), 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('index.html に <body> が見つかりません');
const markup = bodyMatch[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')   // importmap と main.js の読み込みを除去
  .trim();

// 単体でも文字化けしないよう先頭に charset を置いておきます
const page = `<meta charset="utf-8">
<meta name="description" content="東京湾アーリーモーニング — 湾岸の夜明けを走る、三人称視点のハイスピードレース。">
<title>東京湾アーリーモーニング</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&family=Roboto+Condensed:wght@400;600;700&display=swap">
<style>
${css}
</style>

${markup}

<script type="importmap">
{
  "imports": {
    "three": "${threeBase}/build/three.module.min.js",
    "three/addons/": "${threeBase}/examples/jsm/"
  }
}
</script>
<script type="module">
${[...externalImports].join('\n')}
${bodies.join('\n')}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`${out}  (${(page.length / 1024).toFixed(0)} KB)  three: ${threeBase}`);
