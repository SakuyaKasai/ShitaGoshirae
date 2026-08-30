/**
 * reference-types_test.mjs — 参考文献の書式定義と整形処理の検証
 *
 *   node test/reference-types_test.mjs
 *
 * 【1】テンプレート「文　献」節の例示11本を、フィールドに分解 → 再組み立てして
 *      元に戻るかを確認する。全角化した以外は一字一句一致すること。
 * 【2】任意フィールドが空のとき、区切りが浮かないこと。
 * 【3】R01 必須の未入力を、出力からは消して報告だけすること。
 * 【4】R02 記号の重なりを、位置つきで報告すること。
 * 【5】テンプレ側に書式定義の見出しが残っているかの検査。
 * 【6】高信頼フィールドの抽出。著者名・論文名・誌名は切り分けないこと。
 * 【7】種別の推定。手がかりが無ければ null を返すこと。
 * 【8】モーダルの初期状態づくり（prepareGuide）。
 */
import { REFERENCE_TYPES, DELIMITERS, verifyAgainstTemplate } from '../tools/reference-types.mjs';
import {
  formatReference, extractFields, guessType, prepareGuide, buildReference,
} from '../src/reference-format.js';

const TYPES = Object.fromEntries(REFERENCE_TYPES.map(t => [t.id, t]));
const REFS = { delimiters: DELIMITERS, types: REFERENCE_TYPES };

/** 本実装の formatReference を、旧プロトタイプと同じ呼び出し形で使う */
const format = (type, values) => formatReference(type, DELIMITERS, values);
/* ---------------------------------------------------------- */
const CASES = [
  ['journal', {
    authors: '大須賀美恵子, 青木和夫, 他', title: '座談会－ネットで語る人間工学の来し方行く先－',
    journal: '人間工学', year: '2014', volume: '50(1)', pages: '1-10', doi: '10.5100/jje.50.1',
  }, '大須賀美恵子, 青木和夫, 他．座談会－ネットで語る人間工学の来し方行く先－．人間工学．2014，50(1)，p. 1-10．https://doi.org/10.5100/jje.50.1'],

  ['journal', {
    authors: 'Dul, J.; Bruder, R.; et al.', title: 'A strategy for human factors/ergonomics',
    journal: 'Ergonomics', year: '2012', volume: '55(4)', pages: '377-395',
    doi: 'https://doi.org/10.1080/00140139.2012.661087',
  }, 'Dul, J.; Bruder, R.; et al.．A strategy for human factors/ergonomics．Ergonomics．2012，55(4)，p. 377-395．https://doi.org/10.1080/00140139.2012.661087'],

  ['specialIssue', {
    authors: 'French, J. C.; Chapin, A. C.; et al.',
    specialTitle: 'Special topic section, Document search interface design for large-scale collections',
    title: 'Multiple viewpoints as an approach to digital library interfaces',
    journal: 'Journal of the Association for Information Science and Technology',
    year: '2004', volume: '55(10)', pages: '911-922', doi: '10.1002/asi.20035',
  }, 'French, J. C.; Chapin, A. C.; et al.．Special topic section, Document search interface design for large-scale collections：Multiple viewpoints as an approach to digital library interfaces．Journal of the Association for Information Science and Technology．2004，55(10)，p. 911-922．https://doi.org/10.1002/asi.20035'],

  ['proceedings', {
    authors: '青木和夫', title: '日本人間工学会の歴史と現状', proceedingsName: '人間工学',
    venue: '神戸市', period: '2014-06-05/06', organizer: '日本人間工学会', year: '2014', pages: 'S8-S9',
  }, '青木和夫．“日本人間工学会の歴史と現状”．人間工学．神戸市，2014-06-05/06，日本人間工学会，2014，p. S8-S9．'],

  ['proceedings', {
    authors: 'Ebara, T.; Yoshitake, R.; et al.',
    title: 'Impact of Ergonomics good practices database as public relations tools',
    proceedingsName: 'International Ergonomics Association: Proceedings of 17th World congress on Ergonomics',
    venue: 'Beijing, China', period: '2009-08-09/14',
  }, 'Ebara, T.; Yoshitake, R.; et al.．“Impact of Ergonomics good practices database as public relations tools”．International Ergonomics Association: Proceedings of 17th World congress on Ergonomics．Beijing, China，2009-08-09/14．'],

  ['book', {
    authors: '日本人間工学会編', bookTitle: 'ユニバーサルデザイン実践ガイドライン',
    place: '東京', publisher: '共立出版', year: '2003', totalPages: '139',
  }, '日本人間工学会編．ユニバーサルデザイン実践ガイドライン．東京，共立出版，2003，139p．'],

  ['book', {
    authors: 'Ningen, J.', bookTitle: 'Book Title',
    publisher: 'Ergonomics Press', year: '2017', totalPages: '200',
  }, 'Ningen, J.．Book Title．Ergonomics Press，2017，200p．'],

  ['bookChapter', {
    authors: '人間太郎', chapterTitle: '章の見出し', bookTitle: '人間工学実践ガイドライン',
    editor: '日本人間工学会編', place: '東京', publisher: '日本人間工学会', year: '2017', pages: '1-10',
  }, '人間太郎．“章の見出し”．人間工学実践ガイドライン．日本人間工学会編．東京，日本人間工学会，2017，p. 1-10．'],

  ['bookChapter', {
    authors: 'Ningen, T.', chapterTitle: 'Chapter title', bookTitle: 'Book Title',
    edition: '1st ed.', publisher: 'Ergonomics Press', year: '2017', pages: '1-10',
  }, 'Ningen, T.．“Chapter title”．Book Title．1st ed.，Ergonomics Press，2017，p. 1-10．'],

  ['online', {
    authors: '日本人間工学会テレワークガイド委員会',
    pageTitle: '2010年版ノートパソコン利用の人間工学ガイドライン',
    url: 'http://www.ergonomics.jp/product/guideline.html', accessDate: '2012-10-19',
  }, '日本人間工学会テレワークガイド委員会．“2010年版ノートパソコン利用の人間工学ガイドライン”．http://www.ergonomics.jp/product/guideline.html，(参照 2012-10-19)．'],

  ['standard', {
    standardNo: 'ISO 9241-210', year: '2010',
    standardTitle: 'Ergonomics of human-system interaction -- Part 210: Human-centred design for interactive systems',
  }, 'ISO 9241-210:2010．Ergonomics of human-system interaction -- Part 210: Human-centred design for interactive systems．'],
];

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m)); };

console.log('\n【1】テンプレ例示の再現');
for (const [id, values, expect] of CASES) {
  const { text } = format(TYPES[id], values);
  if (text === expect) { pass++; console.log(`  ✅ ${id.padEnd(13)} ${text.slice(0, 50)}…`); }
  else { fail++; console.log(`  ❌ ${id}\n     期待: ${expect}\n     実際: ${text}`); }
}

console.log('\n【2】任意フィールドの脱落と区切りの引き継ぎ');
ok(format(TYPES.book, { authors:'A', bookTitle:'B', place:'C', publisher:'D', year:'2020' }).text
   === 'A．B．C，D，2020．', '版表示なし → 書名の「．」が出版地の前に来る');
ok(format(TYPES.book, { authors:'A', bookTitle:'B', publisher:'D', year:'2020' }).text
   === 'A．B．D，2020．', '版表示・出版地なし → 区切りが浮かない');
ok(format(TYPES.journal, { authors:'A', title:'B', journal:'C', year:'2020', volume:'1(2)', pages:'3-4' }).text
   === 'A．B．C．2020，1(2)，p. 3-4．', 'DOIなし → 末尾に終端記号');
ok(format(TYPES.journal, { authors:'A', title:'B', journal:'C', year:'2020', volume:'1(2)', doi:'10.1/x' }).text
   === 'A．B．C．2020，1(2)．https://doi.org/10.1/x', 'DOIあり → URLの後ろに終端記号を付けない');

console.log('\n【3】R01 必須の未入力 — 出力からは消し、報告だけする');
{
  const r = format(TYPES.book, { authors:'A', bookTitle:'B', year:'2020' });
  ok(r.text === 'A．B．2020．', `穴埋め記号を出さない → ${r.text}`);
  ok(!/［|］|\[|\]/.test(r.text), '出力に ［ ］ が混入していない');
  const r01 = r.notices.filter(n => n.id === 'R01');
  ok(r01.length === 1 && r01[0].field === 'publisher', `未入力を報告: ${r01.map(n=>n.fieldLabel)}`);
}
{
  const r = format(TYPES.online, { pageTitle:'T', url:'http://x.jp' });
  const f = r.notices.filter(n => n.id === 'R01').map(n => n.field);
  ok(f.length === 2 && f.includes('authors') && f.includes('accessDate'),
     `複数の未入力をまとめて報告: ${r.notices.filter(n=>n.id==='R01').map(n=>n.fieldLabel)}`);
}

console.log('\n【4】R02 記号の重なり — 位置つきで報告する');
{
  const r = format(TYPES.journal, {
    authors:'Dul, J.; Bruder, R.; et al.', title:'B', journal:'C', year:'2020', volume:'1(2)',
  });
  const n = r.notices.find(x => x.id === 'R02');
  ok(!!n, `検出: ${n?.message}`);
  ok(n.field === 'authors', '原因のフィールドを特定している');
  ok(r.text.slice(n.at, n.at + n.length) === '.．',
     `位置が正しい → text[${n.at}..] = "${r.text.slice(n.at, n.at + n.length)}"`);
  console.log(`     UI表示: …${n.excerpt}…`);
  console.log(`     ${n.suggestion}`);
}
{
  const r = format(TYPES.bookChapter, {
    authors:'人間太郎', chapterTitle:'章', bookTitle:'書', edition:'1st ed.',
    publisher:'出', year:'2020',
  });
  const n = r.notices.find(x => x.id === 'R02');
  ok(n && n.field === 'edition' && r.text.slice(n.at, n.at + 2) === '.，',
     `版表示 "1st ed." + "，" を検出 → ${n?.excerpt}`);
}
ok(format(TYPES.book, { authors:'日本人間工学会編', bookTitle:'書', publisher:'出', year:'2020', totalPages:'139' })
   .notices.filter(n => n.id === 'R02').length === 0,
   '和文のみ・略記なしでは誤検出しない');

console.log('\n【5】テンプレ側の見出し検査');
{
  const fake = REFERENCE_TYPES.map(t => t.marker).join('\n');
  const r2 = verifyAgainstTemplate(fake.replace('＜ISO/JISなどの規格文書の場合＞', ''));
  ok(verifyAgainstTemplate(fake).ok && !r2.ok && r2.missing.length === 1,
     `全7種検出 / 1種欠落を検知 → ${r2.missing}`);
}


console.log('\n【6】高信頼フィールドの抽出 — 著者・論文名・誌名は切り分けない');
{
  const r = extractFields('青木和夫：着物の腰紐に関する研究：人間工学，2020，56(2)，45-52');
  ok(r.fields.year === '2020' && r.fields.volume === '56(2)' && r.fields.pages === '45-52',
     `実データ形式 → year/volume/pages を抽出: ${JSON.stringify(r.fields)}`);
  ok(r.rest === '青木和夫：着物の腰紐に関する研究：人間工学',
     `残りが人手で切る3塊になる → 「${r.rest}」`);
  ok(!('authors' in r.fields) && !('title' in r.fields) && !('journal' in r.fields),
     '著者名・論文名・誌名は推測で埋めない');
}
{
  const r = extractFields('… 2014, 50(1), p. 1-10. https://doi.org/10.5100/jje.50.1');
  ok(r.fields.doi === '10.5100/jje.50.1', `DOI: ${r.fields.doi}`);
  ok(r.fields.year === '2014', 'DOI 内の数字を出版年と取り違えない');
  ok(r.fields.pages === '1-10', `ページ: ${r.fields.pages}`);
}
{
  const r = extractFields('… 神戸市, 2014-06-05/06, 日本人間工学会, 2014, p. S8-S9.');
  ok(r.fields.period === '2014-06-05/06', `会議開催期間: ${r.fields.period}`);
  ok(r.fields.year === '2014', '開催期間から年を誤って抜かない');
  ok(r.fields.pages === 'S8-S9', 'S 付きページも拾う');
}
{
  const r = extractFields('… http://www.ergonomics.jp/outline.html, (参照2021-04-01).');
  ok(r.fields.url === 'http://www.ergonomics.jp/outline.html', `URL: ${r.fields.url}`);
  ok(r.fields.accessDate === '2021-04-01', '参照日を YYYY-MM-DD に揃える');
}
ok(extractFields('… 2021/4/1 …').fields.year === '2021', 'スラッシュ区切りでも年を拾う');
ok(extractFields('日本人間工学会編．…, 東京，共立出版，2003，139p.').fields.totalPages === '139',
   '総ページ数 139p. を拾う');
ok(extractFields('… 第50巻第1号 …').fields.volume === '50(1)', '和文の巻号表記も拾う');
{
  const r = extractFields('ISO 9241-210:2010. Ergonomics of human-system interaction.');
  ok(r.fields.standardNo === 'ISO 9241-210' && r.fields.year === '2010',
     `規格番号と制定年を分離: ${r.fields.standardNo} / ${r.fields.year}`);
}
ok(Object.keys(extractFields('何かよくわからない文字列').fields).length === 0,
   '手がかりが無ければ何も埋めない');

console.log('\n【7】種別の推定 — 根拠が無ければ null');
{
  const cases = [
    ['ISO 9241-210:2010. Ergonomics…', 'standard', 'high'],
    ['… http://www.ergonomics.jp/x.html, (参照2021-04-01).', 'online', 'high'],
    ['… 神戸市, 2014-06-05/06, 日本人間工学会, 2014, p. S8-S9.', 'proceedings', 'medium'],
    ['日本人間工学会編．…，共立出版，2003，139p.', 'book', 'medium'],
    ['青木和夫：着物…：人間工学，2020，56(2)，45-52', 'journal', 'medium'],
  ];
  for (const [line, id, conf] of cases) {
    const g = guessType(line);
    ok(g.id === id && g.confidence === conf, `${id.padEnd(12)} [${g.confidence}] ${g.reason}`);
  }
  const g = guessType('何かよくわからない文字列');
  ok(g.id === null, `手がかりが無ければ null → ${g.reason}`);
}

console.log('\n【8】モーダルの初期状態');
{
  const g = prepareGuide('青木和夫：着物の腰紐に関する研究：人間工学，2020，56(2)，45-52', REFS);
  ok(g.typeId === 'journal', `種別を推定: ${g.typeId}`);
  ok(g.found.includes('year') && g.found.includes('volume') && g.found.includes('pages'),
     `自動で入れた欄を伝える: ${g.found.join(', ')}`);
  ok(g.original.length > 0 && g.rest.length > 0, '元の文字列と残りの両方を保持する');
}
{
  // 書籍として拾った totalPages を、論文へ切り替えたとき持ち越さない
  const g = prepareGuide('…，共立出版，2003，139p.', REFS, 'journal');
  ok(!('totalPages' in g.fields), '型に無いフィールドは持ち越さない');
  ok(g.fields.year === '2003', '型にあるフィールドは残る');
}
{
  // 抽出 → 組み立ての往復
  const g = prepareGuide('青木和夫：着物の腰紐に関する研究：人間工学，2020，56(2)，45-52', REFS);
  const r = buildReference(REFS, g.typeId, {
    ...g.fields, authors: '青木和夫', title: '着物の腰紐に関する研究', journal: '人間工学',
  });
  ok(r.text === '青木和夫．着物の腰紐に関する研究．人間工学．2020，56(2)，p. 45-52．',
     `往復して規定準拠になる → ${r.text}`);
  ok(r.notices.length === 0, '警告なし');
}
ok(buildReference(REFS, 'nonexistent', {}).text === '', '未知の型IDでも落ちない');

console.log(`\n===== ${pass} passed, ${fail} failed =====\n`);
process.exit(fail === 0 ? 0 : 1);
