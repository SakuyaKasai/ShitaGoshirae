import fs from 'fs';
import {
  listDeclaredExtensions, ensureContentTypeDefaults,
  scanMaxRIdNumber, RIdAllocator,
  scanMaxDocPrId, DocPrIdAllocator,
  sniffImage, computeExtent, COLUMN_WIDTH
} from '../src/image-transfer.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✅',m)):(fail++,console.log('  ❌',m)); };

const ct   = fs.readFileSync('[Content_Types].xml','utf8');
const rels = fs.readFileSync('document.xml.rels','utf8');
const png  = new Uint8Array(fs.readFileSync('image1.png'));
const docXml = fs.readFileSync('./document.xml','utf8');

console.log('\n【1】Content_Types');
const declared = listDeclaredExtensions(ct);
ok(declared.has('png'), `既存の登録を検出: ${[...declared].join(', ')}`);
ok(!declared.has('jpeg'), 'jpeg は未登録（＝地雷が実在する）');
const r1 = ensureContentTypeDefaults(ct, ['png','jpeg','emf']);
ok(r1.added.join(',')==='jpeg,emf', `追加された拡張子: ${r1.added.join(', ')}`);
ok((r1.xml.match(/Extension="png"/g)||[]).length===1, 'png は重複追加されていない');
ok(r1.xml.indexOf('<Default Extension="jpeg"') < r1.xml.indexOf('<Override'), 'Default が Override より前');
ok(/^<\?xml/.test(r1.xml), 'XML宣言が保持されている');

console.log('\n【2】rId 採番');
const max = scanMaxRIdNumber(rels);
ok(max===14, `使用済み最大 rId = ${max}（末尾要素は rId14 ではなく順不同）`);
const alloc = new RIdAllocator(rels);
const a=alloc.addImage('media/image2.png'), b=alloc.addImage('media/image3.jpeg');
ok(a==='rId15' && b==='rId16', `払い出し: ${a}, ${b}`);
const rels2 = alloc.apply(rels);
const ids = [...rels2.matchAll(/Id="(rId\d+)"/g)].map(m=>m[1]);
ok(new Set(ids).size===ids.length, `衝突なし（全 ${ids.length} 件がユニーク）`);

console.log('\n【3】docPr id 採番');
const maxDoc = scanMaxDocPrId([docXml]);
ok(maxDoc===18, `使用済み最大 docPr id = ${maxDoc}`);
const dalloc = new DocPrIdAllocator([docXml]);
ok(dalloc.allocate()===19 && dalloc.allocate()===20, '19, 20 を払い出し');

console.log('\n【4】画像サニフィング & 寸法');
const info = sniffImage(png);
ok(info.ext==='png', `形式判定: ${info.ext}`);
ok(info.width>0 && info.height>0, `実ピクセル: ${info.width} × ${info.height}`);

// テンプレ実物の extent と突き合わせ
const srcExtent = { cx: 2943225, cy: 2105025 };
const e1 = computeExtent({ srcExtent, intrinsic: info, targetCx: COLUMN_WIDTH.single });
ok(e1.aspectSource==='srcExtent', 'アスペクト比は srcExtent を優先');
const ratioSrc = srcExtent.cy/srcExtent.cx, ratioOut = e1.cy/e1.cx;
ok(Math.abs(ratioSrc-ratioOut)<0.0001, `比率が保存されている（${ratioSrc.toFixed(4)} → ${ratioOut.toFixed(4)}）`);
console.log(`     → 片段配置: ${e1.cx} × ${e1.cy} EMU = ${(e1.cx/36000).toFixed(1)} × ${(e1.cy/36000).toFixed(1)} mm, ${e1.effectiveDpi} dpi`);

const e2 = computeExtent({ srcExtent: null, intrinsic: info, targetCx: COLUMN_WIDTH.single });
ok(e2.aspectSource==='intrinsic', 'srcExtent が無ければ実ピクセルにフォールバック');

// トリミング済み画像の再現: 正方形2000pxを横長に表示している場合
const cropped = computeExtent({
  srcExtent:{cx:4000000, cy:1000000}, intrinsic:{width:2000,height:2000},
  targetCx: COLUMN_WIDTH.single });
ok(Math.abs((cropped.cy/cropped.cx) - 0.25) < 0.0001,
   `トリミング画像が伸びない（4:1 を維持 → ${(cropped.cx/cropped.cy).toFixed(1)}:1）`);

const e3 = computeExtent({ srcExtent:null, intrinsic:{width:null,height:null}, targetCx: COLUMN_WIDTH.single });
ok(e3.aspectSource==='fallback', '両方無ければ fallback（警告対象）');

// 低解像度の検出
const low = computeExtent({ srcExtent:null, intrinsic:{width:300,height:200}, targetCx: COLUMN_WIDTH.single });
ok(low.effectiveDpi < 150, `低解像度を検出: ${low.effectiveDpi} dpi（W12 が発火）`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail?1:0);
