import fs from 'fs';
import { convert } from '../src/pipeline.js';
const manifest = JSON.parse(fs.readFileSync(new URL('../src/manifest.json', import.meta.url)));
const u = p => fs.readFileSync(new URL(p, import.meta.url));

const res = await convert({
  templateBytes: u('../template.docx'),
  sourceBytes: u('../fixture-source.docx'),
  manifest,
  meta: {
    japaneseTitle: '女性腰紐着付け構造の数値解析条件への変換手法',
    titleFootnote: '1',
    japaneseAuthors: [{name:'青木　友里',affiliation:'2'},{name:'笠井　美穂',affiliation:'3'}],
    englishTitle: "A Conversion Method from Women's Kimono Waist-Cord Dressing Structures",
    englishAuthors: ['Yuri AOKI','Miho KASAI'],
    japaneseAbstract: '和文抄録の本文がここに入る．'.repeat(20),
    englishAbstract: 'This is the english abstract. '.repeat(20),
    keywords: ['着物','着付け','腰紐','荷重流路','静力学'],
    received: '受付：2026年8月16日',
    affiliations: [
      {mark:'2', text:'人間工学大学人間工学学部 / School of Ergonomics'},
      {mark:'3', text:'人間工学研究所 / Institute of Ergonomics'},
    ],
  },
  autoFixIds: ['W01','W02','W15'],
});
fs.writeFileSync(new URL('../out.docx', import.meta.url), res.bytes);
console.log('report:', JSON.stringify(res.report, (k,v)=>k==='outline'?`[${v.length}件]`:v, 1));
console.log('\n警告一覧:');
for (const w of res.warnings) console.log(` [${w.id}] ${w.level} ${String(w.message).slice(0,70)}`);
