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
  //   配布物 index.html を file:// で開く。ソースを直したら先に npm run build すること。
  { file: 'ui_test.mjs', cwd: root, needs: 'fixture-full.docx', optional: true },
  { file: 'reference-guide_test.mjs', cwd: root, needs: 'fixture-full.docx', optional: true },
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
  console.log(`\n${'─'.repeat(56)}\n▶ ${s.file}`);
  try {
    const out = execFileSync('node', [path.join(root, 'test', s.file)],
      { cwd: s.cwd, encoding: 'utf8' });
    const m = /(\d+) passed, (\d+) failed/.exec(out);
    if (m) { total += Number(m[1]); failed += Number(m[2]); }
    console.log(out.trim().split('\n').slice(-1)[0]);
  } catch (err) {
    const out = String(err.stdout ?? '') + String(err.stderr ?? '');
    const m = /(\d+) passed, (\d+) failed/.exec(out);
    if (m) { total += Number(m[1]); failed += Number(m[2]); }
    else failed++;
    console.log(out.split('\n').filter(l => l.includes('❌')).join('\n') || out.slice(-500));
    if (s.optional) { console.log(`   （${s.file} は環境依存のため、失敗しても止めません）`); }
  }
}

fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${'═'.repeat(56)}`);
console.log(`  合計 ${total} passed / ${failed} failed${skipped ? ` / ${skipped} skipped` : ''}`);
console.log('═'.repeat(56));
process.exit(failed ? 1 : 0);
