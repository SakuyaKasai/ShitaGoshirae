/**
 * reference-types_test.mjs — 参考文献の書式定義（型と組み立てモデル）の検証
 *
 *   node test/reference-types_test.mjs
 *
 * テンプレート「文　献」節の例示11本を、フィールドに分解 → 再組み立てして
 * 元に戻るかを確認する。全角化した以外は一字一句一致すること。
 *
 * 注: 下の format() は組み立てモデルの検証用プロトタイプである。
 *     ステップ2で src/reference-format.js を実装したら、この関数を消して
 *     import に差し替えること（アサーションはそのまま使える）。
 */
import { REFERENCE_TYPES, DELIMITERS, verifyAgainstTemplate } from '../tools/reference-types.mjs';

const TYPES = Object.fromEntries(REFERENCE_TYPES.map(t => [t.id, t]));

/**
 * 値の末尾の区切り記号を落とす。
 * 半角ピリオドは落とさない — "1st ed." "et al." "J." のように
 * 略記や頭文字の一部であることが多く、機械的には区別できないため。
 * （テンプレ例示も "1st ed., Ergonomics Press" と両方を並べている）
 */
const trimTail = (v, isUrl) => isUrl ? v : v.replace(/[．，、。,;；\s\u3000]+$/, '');

/** prefix を二重に付けない（DOI を URL ごと貼られた場合） */
const applyPrefix = (prefix, v) => !prefix || v.startsWith(prefix) ? v : prefix + v;

/** 半角の区切りと全角の区切りが隣り合っているか */
const HALF_TAIL = /[.,;:]$/;

/**
 * @returns {{ text, notices }}
 *   notices[] = { id, level, field, fieldLabel, at, length, excerpt, message, suggestion }
 *     at / length …… text 内の文字位置。UI はここをハイライトする
 */
function format(type, values) {
  const emitted = [];
  const notices = [];

  for (const f of type.fields) {
    const raw = String(values[f.key] ?? '').trim();
    if (!raw) {
      // 空欄はフィールドごと消す。穴埋め記号は出さない。
      if (f.required) {
        notices.push({
          id: 'R01', level: 'warn', field: f.key, fieldLabel: f.label,
          message: `${f.label}が未入力です`,
          suggestion: '規定ではこの型に必要な項目です。原著をご確認ください',
        });
      }
      continue;
    }
    const isUrl = f.autofill === 'url' || f.autofill === 'doi';
    const v = trimTail(raw, isUrl);
    emitted.push({ f, text: applyPrefix(f.prefix ?? '', v) + (f.suffix ?? '') });
  }
  if (!emitted.length) return { text: '', notices };

  let text = emitted[0].text;
  for (let i = 1; i < emitted.length; i++) {
    const key = emitted[i].f.lead ?? emitted[i - 1].f.follow;
    const delim = DELIMITERS[key] ?? '';
    checkCollision(notices, emitted[i - 1].f, text, delim, emitted[i].text);
    text += delim + emitted[i].text;
  }

  const last = emitted[emitted.length - 1].f;
  if (!last.suppressTerminal && type.terminal) {
    const delim = DELIMITERS[type.terminal];
    checkCollision(notices, last, text, delim, '');
    text += delim;
  }
  return { text, notices };
}

/** 直前の出力が半角の記号で終わっていて、その後ろに全角の区切りが来る場合 */
function checkCollision(notices, field, textSoFar, delim, nextText) {
  if (!delim || !HALF_TAIL.test(textSoFar)) return;
  const tail = textSoFar.slice(-1);
  const at = textSoFar.length - 1;
  notices.push({
    id: 'R02', level: 'info', field: field.key, fieldLabel: field.label,
    at, length: 2,
    excerpt: textSoFar.slice(Math.max(0, at - 8)) + delim + nextText.slice(0, 8),
    message: `${field.fieldLabel ?? field.label}の末尾の「${tail}」と、区切りの「${delim}」が並んでいます`,
    suggestion: `${field.label}の末尾から「${tail}」を消すと「${tail}${delim}」が「${delim}」になります`,
  });
}

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

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passing / ${fail} failing\n`);
process.exit(fail === 0 ? 0 : 1);
