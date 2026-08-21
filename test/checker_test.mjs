import {
  checkPunctuation, checkUnitSpacing, checkMathChars, checkCitations,
  checkEnglishTitle, checkEnglishAuthors, checkKeywords, checkTwoCharHeadings,
  runChecks, applyFixes, applyFixesById, findReferenceSection,
  collectReferences, collectCitations,
} from '../src/checker.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✅',m)):(fail++,console.log('  ❌',m)); };

console.log('\n【1】W01/W02 句読点');
const p = 'これはテストです。次の文、読点もあります。最後です。';
const pr = checkPunctuation(p);
ok(pr.find(r=>r.id==='W01').count===3, `句点3件を検出`);
ok(pr.find(r=>r.id==='W02').count===1, `読点1件を検出`);
const fixed = applyFixes(p, pr.flatMap(r=>r.fixes));
ok(fixed==='これはテストです．次の文，読点もあります．最後です．', `一括修正: ${fixed}`);

console.log('\n【2】W15 単位のスペース');
const u = '周波数は32kHzで、重さは5.5kgでした。2024年に実施。信号はF1とT2で記録。';
const ur = checkUnitSpacing(u);
ok(ur.length===1 && ur[0].count===2, `2件検出（32kHz / 5.5kg）`);
ok(!applyFixes(u,ur[0].fixes).includes('2024 年'), '年号を誤爆していない');
console.log('     →', applyFixes(u, ur[0].fixes));

console.log('\n【3】W07 Unicode数式文字');
const mathLines = ['ΣᵢFᵢ＝0','F＝∫Sf(s)dS','α波を測定した．','通常の本文です．'];
const mr = checkMathChars(mathLines);
ok(mr.length===1 && mr[0].count===2, `数式行2件を検出（α波の行は除外）`);
console.log('     →', mr[0].detail.join(' / '));

console.log('\n【4】W05/W06 引用と文献');
const doc = [
  '1. はじめに',
  '先行研究では указано されている1)．また別の報告2)もある．',
  '本研究では5)の手法を用いた．',
  '文　献',
  '1) 大須賀美恵子, 他. 座談会. 人間工学. 2014.',
  '2) Dul, J. et al. Ergonomics. 2012.',
  '3) 青木和夫. 日本人間工学会の歴史と現状. 2014.',
];
ok(findReferenceSection(doc)===3, '「文　献」を3行目で検出');
ok(collectReferences(doc,3).length===3, '文献3件を抽出');
const cites = collectCitations(doc,3);
ok(cites.has(1)&&cites.has(2)&&cites.has(5), `引用番号を抽出: ${[...cites].join(', ')}`);
const cr = checkCitations(doc);
ok(cr.some(r=>r.id==='W05'&&r.message.includes('3)')), 'W05: 文献3)が未引用');
ok(cr.some(r=>r.id==='W06'&&r.message.includes('5)')), 'W06: 本文の5)に文献なし');

console.log('\n【5】箇条書きの誤爆回避');
const bullets = ['文　献','1) 文献A','2) 文献B'];
const bl = ['[新規性]：下記の1)～4)のうち，1つが満たされていること．','1) 新しい発見または知見の提示','2) 新しい理論の提案','文　献','1) 文献A'];
const bc = collectCitations(bl, 3);
ok(!bc.has(2), '行頭の "2)" を引用として拾っていない（箇条書き）');
ok(bc.has(1)&&bc.has(4), `行中の "1)～4)" は引用候補として拾う: ${[...bc].join(', ')}`);

console.log('\n【6】W16 英文タイトル');
const t1 = "A Conversion Method from Women's Kimono Waist-Cord Dressing Structures to Numerical Analysis Conditions";
const r1 = checkEnglishTitle(t1);
ok(!r1.some(r=>r.id==='W16'), '現行原稿のタイトルは規定準拠（W16なし）');
ok(r1.some(r=>r.id==='W18'), 'W18: ハイフン語 Waist-Cord を情報として通知');
const t2 = 'a study Of the effects on human factors';
const r2 = checkEnglishTitle(t2);
const w16 = r2.find(r=>r.id==='W16');
ok(w16 && w16.count===6, `6件検出（全小文字タイトル）: ${w16.fixes.map(f=>f.context).join(' / ')}`);
ok(applyFixes(t2,w16.fixes)==='A Study of the Effects on Human Factors',
   `修正後: ${applyFixes(t2,w16.fixes)}`);

console.log('\n【7】W17 英文著者名');
ok(checkEnglishAuthors(['Yuri AOKI','Miho KASAI']).length===0, '正しい姓（全大文字）は警告なし');
const a2 = checkEnglishAuthors(['Yuri Aoki','Miho KASAI']);
ok(a2.length===1 && a2[0].count===1, `1件検出: ${a2[0].fixes[0].before} → ${a2[0].fixes[0].after}`);

console.log('\n【8】W22 2文字見出し');
const h22 = ['1. はじめに','文献','謝辞','利益相反'];
const r22 = checkTwoCharHeadings(h22);
ok(r22[0].count===2, `文献・謝辞の2件を検出（利益相反は4文字なので対象外）`);

console.log('\n【9】W10 キーワード');
ok(checkKeywords(['a','b','c','d','e']).length===0, '5個なら警告なし');
ok(checkKeywords(['a','b','c']).length===1, '3個なら情報');

console.log('\n【10】統合実行');
const full = [
  '1. はじめに',
  'これは本文です。読点、もあります。周波数は32kHzでした。',
  '2. 方法',
  '2-1. 対象',
  '先行研究1)を参考にした。',
  '１．２　表記ゆれのある見出し',
  '文献',
  '1) 文献A',
  '2) 文献B',
].join('\n');
const res = runChecks(full, {
  englishTitle: 'a Study Of Ergonomics',
  englishAuthors: ['Taro Yamada'],
  keywords: ['a','b','c'],
});
ok(res.summary.warn > 0 && res.summary.info > 0, `warn=${res.summary.warn} / info=${res.summary.info} / 自動修正可=${res.summary.autoFixable}`);
console.log('     検出一覧:');
for (const r of res.results) console.log(`       [${r.id}] ${r.level} — ${r.message.slice(0,62)}`);

console.log('\n【11】オフセットずれの検証（最重要）');
const many = '。'.repeat(50) + 'あ' + '、'.repeat(50);
const mr2 = checkPunctuation(many);
const applied = applyFixes(many, mr2.flatMap(r=>r.fixes));
ok(applied === '．'.repeat(50)+'あ'+'，'.repeat(50), '100件の一括修正でオフセットがずれない');
ok(applied.length === many.length, '文字数が変わらない');

// 長さの変わる修正が混在するケース
const mixed = '32kHzで測定。5kgの重り、以上。';
const mres = runChecks(mixed);
const allFixed = applyFixesById(mixed, mres.results, ['W01','W02','W15']);
ok(allFixed === '32 kHzで測定．5 kgの重り，以上．', `長さの変わる修正が混在しても正しい: ${allFixed}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail?1:0);
