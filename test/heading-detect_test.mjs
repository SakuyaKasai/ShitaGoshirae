import { detectHeading, normalizeNumberToken, analyzeHeadings, formatNumber, applyKintouWariduke }
  from '../src/heading-detect.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✅',m)):(fail++,console.log('  ❌',m)); };

console.log('\n【1】番号の正規化（表記ゆれの吸収）');
const variants = ['1.2','１．２','1-2','１-２','1 . 2','１　．　２','1．2.','1-2-'];
const norm = variants.map(normalizeNumberToken);
ok(norm.every(n=>n==='1.2'), `8種の表記がすべて "1.2" に collapse: ${variants.join(' / ')}`);

console.log('\n【2】見出しの判定（テンプレ実物の表記）');
const cases = [
  ['1. はじめに',            1, '1'],
  ['2. 方　法',              1, '2'],
  ['2-1. 投稿原稿の様式',     2, '2.1'],
  ['3-2. 論文で用いる単位系',  2, '3.2'],
  ['１．はじめに',            1, '1'],
  ['1．2　図表の作り方',       2, '1.2'],
  ['2-1-1. さらに細かい項目',  3, '2.1.1'],
  ['1 はじめに',              1, '1'],
];
for (const [line, lv, num] of cases) {
  const h = detectHeading(line);
  ok(h.isHeading && h.level===lv && h.number===num,
     `"${line}" → L${h.level} / ${h.number} (${h.confidence})`);
}

console.log('\n【3】見出しでないものを弾く');
const negatives = [
  '1) 新しい発見または知見の提示',
  '(1) 括弧付きの箇条書き',
  '2024.4.1 改定',
  '3.5 kg の重りを用いた．',
  '本文中には，引用個所の右肩に文献の番号を記載し，',
  '2.',
  '1.2.3.4.5 過剰な階層の数値列',
  '',
];
for (const line of negatives) {
  const h = detectHeading(line);
  ok(!h.isHeading, `弾いた: "${line.slice(0,34)}"`);
}

console.log('\n【4】文書全体の整合性チェック');
const doc = [
  '1. はじめに','本文本文本文．',
  '2. 方　法','2-1. 対象','2-2. 手順',
  '3. 結　果','3-1. 主要な結果','3-1. 重複した番号',
  '3-3. 番号が飛んでいる',
  '4-1-1-1. 深すぎる見出し',
  '文　献','1) 大須賀美恵子, 他. 座談会. 人間工学. 2014.','2) Dul, J. et al. Ergonomics. 2012.',
];
const r = analyzeHeadings(doc);
ok(r.stats.referenceSectionAt !== null, `「文　献」を検出（${r.stats.referenceSectionAt}行目）→ 以降の判定を停止`);
ok(!r.headings.some(h=>h.index > r.stats.referenceSectionAt), '文献リストの "1)" を見出しとして拾っていない');
const ids = r.warnings.map(w=>w.id);
ok(ids.includes('W04'), 'W04: 重複と欠番を検出');
ok(r.warnings.some(w=>/3\.2/.test(w.message)), '欠番 3.2 を具体的に指摘');
ok(ids.includes('W30'), 'W30: 4階層を検出');
console.log('     警告一覧:');
for (const w of r.warnings) console.log(`       [${w.id}] ${w.message}`);

console.log('\n【5】出力用の整形');
ok(formatNumber([1])==='1. ' && formatNumber([2,1])==='2-1. ',
   `テンプレ表記へ復元: ${formatNumber([1])}/ ${formatNumber([2,1])}`);
ok(applyKintouWariduke('方法')==='方\u3000法', '2文字見出しに全角スペース: 方法 → 方　法');
ok(applyKintouWariduke('はじめに')==='はじめに', '4文字は変更しない');
ok(applyKintouWariduke('利益相反')==='利益相反', '利益相反も変更しない');

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail?1:0);
