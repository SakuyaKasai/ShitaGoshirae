/**
 * run-all.mjs — テストを全部走らせる。
 *
 *   node test/run-all.mjs
 *
 * 既存4本のテストはテンプレを展開した素の XML ファイルを
 * カレントディレクトリから読む前提で書かれている。
 * 毎回手で unzip するのは事故のもとなので、ここで用意してから走らせる。
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
const work = path.join(root, '.testwork');

/* ---------- テンプレを展開して素材を並べる ---------- */
fs.mkdirSync(work, { recursive: true });
const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'template.docx')));
const lay = {
  '[Content_Types].xml': '[Content_Types].xml',
  'word/document.xml': 'document.xml',
  'word/_rels/document.xml.rels': 'document.xml.rels',
  'word/numbering.xml': 'numbering.xml',
  'word/media/image1.png': 'image1.png',
};
for (const [src, dst] of Object.entries(lay)) {
  const f = zip.file(src);
  if (!f) throw new Error(`テンプレに ${src} がありません`);
  fs.writeFileSync(path.join(work, dst), await f.async('nodebuffer'));
}

/* ---------- 検証用の原稿を用意する ---------- */
for (const [script, out] of [
  ['make-fixture.py', 'fixture-source.docx'],
  ['make-fixture-full.py', 'fixture-full.docx'],
]) {
  if (fs.existsSync(path.join(root, out))) continue;
  try {
    execFileSync('python3', [path.join(root, 'tools', script), path.join(root, out)],
      { cwd: root, stdio: 'inherit' });
  } catch {
    console.log(`⚠️ ${out} を作れませんでした（python-docx と Pillow が要ります）。関連テストは飛ばします`);
  }
}

/* ---------- ブラウザ用に「いまのソースから焼いた1枚」を用意する ----------
 *
 * ブラウザテストは配布物 HTML を file:// で開く。リポジトリの index.html を
 * そのまま開くと、**ソースを直しても古い配布物を検証してしまう**。
 *   - npm test は build を呼ばない
 *   - dev の index.html / manifest.json は意図的に古い（CI が焼くのは main だけ）
 * この2つが重なると「直したのにテストが古い挙動で落ちる／古いまま緑になる」。
 * 実際に両方踏んだ（→ handoff 15-9）。
 *
 * そこでランナー側で .testwork へ焼き、そちらを開かせる。
 * 作業ツリーの index.html / src/manifest.json には触らない。
 */
const bundle = path.join(work, 'index.html');
let bundleReady = false;
try {
  const tmpManifest = path.join(work, 'manifest.json');
  execFileSync('node', [path.join(root, 'tools/build-manifest.mjs'),
                        path.join(root, 'template.docx'), tmpManifest],
               { cwd: root, stdio: 'pipe' });
  execFileSync('node', [path.join(root, 'tools/build-bundle.mjs'), bundle, tmpManifest],
               { cwd: root, stdio: 'pipe' });
  bundleReady = true;
  console.log(`\n📦 検証用の配布物を焼きました: ${path.relative(root, bundle)}`);
} catch (err) {
  console.log(`\n⚠️ 検証用の配布物を焼けませんでした。ブラウザテストは飛ばします\n${String(err.stderr ?? err).slice(0, 300)}`);
}

/* ---------- 実行 ---------- */
const suites = [
  // テンプレ素材を読むもの（カレントを .testwork にして走らせる）
  { file: 'checker_test.mjs', cwd: work },
  { file: 'heading-detect_test.mjs', cwd: work },
  { file: 'numbering-merge_test.mjs', cwd: work },
  { file: 'image-transfer_test.mjs', cwd: work },
  // 原稿を読むもの
  { file: 'source-parse_test.mjs', cwd: root, needs: 'fixture-source.docx' },
  { file: 'compose_test.mjs', cwd: root, needs: 'fixture-source.docx' },
  //
  // test/pipeline_test.mjs はここに載せない。名前に反して**テストではない**。
  // アサーションを1つも持たず、report と警告一覧を表示して out.docx を書き出す
  // だけの手動確認用スクリプトである。走らせても合否は増えず、出力だけ濁る。
  // pipeline の中身は compose_test.mjs が検証している。
  //
  // ブラウザ（環境が無ければ飛ばす）
  //   開くのは .testwork に焼いた1枚。リポジトリの index.html ではない（上の説明を参照）。
  { file: 'ui_test.mjs', cwd: root, needs: 'fixture-full.docx', browser: true },
  { file: 'reference-guide_test.mjs', cwd: root, needs: 'fixture-full.docx', browser: true },
  // ファイルを読まないもの
  { file: 'reference-types_test.mjs', cwd: root },
];

let total = 0, failed = 0, skipped = 0;

for (const s of suites) {
  if (s.needs && !fs.existsSync(path.join(root, s.needs))) {
    console.log(`\n⏭  ${s.file} — ${s.needs} が無いので飛ばします`);
    skipped++;
    continue;
  }
  if (s.browser && !bundleReady) {
    console.log(`\n⏭  ${s.file} — 検証用の配布物が無いので飛ばします`);
    skipped++;
    continue;
  }
  console.log(`\n${'─'.repeat(56)}\n▶ ${s.file}`);
  try {
    const out = execFileSync('node', [path.join(root, 'test', s.file)],
      { cwd: s.cwd, encoding: 'utf8',
        env: { ...process.env, ...(s.browser ? { BUNDLE_HTML: bundle } : {}) } });
    const m = /(\d+) passed, (\d+) failed/.exec(out);
    if (m) { total += Number(m[1]); failed += Number(m[2]); }
    console.log(out.trim().split('\n').slice(-1)[0]);
  } catch (err) {
    // 終了コード 97 は「環境が足りなくて走れなかった」の合図（→ ブラウザテスト冒頭）。
    // それ以外の失敗は、すべて不具合として数える。
    // かつて optional: true で全部を「環境依存」と言っていたが、
    // **本物の回帰まで同じ文言で流してしまう**ため、区別する形に改めた。
    if (err.status === 97) {
      console.log(String(err.stdout ?? '').trim() || '   環境が足りないため飛ばしました');
      skipped++;
      continue;
    }
    const out = String(err.stdout ?? '') + String(err.stderr ?? '');
    const m = /(\d+) passed, (\d+) failed/.exec(out);
    if (m) { total += Number(m[1]); failed += Number(m[2]); }
    else failed++;
    console.log(out.split('\n').filter(l => l.includes('❌')).join('\n') || out.slice(-500));
  }
}

fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${'═'.repeat(56)}`);
console.log(`  合計 ${total} passed / ${failed} failed${skipped ? ` / ${skipped} skipped` : ''}`);
console.log('═'.repeat(56));
process.exit(failed ? 1 : 0);
