/**
 * style-import.js — 原稿が参照しているスタイル定義を出力側へ運ぶ。
 *
 * なぜ必要か:
 *   テンプレの styles.xml には styleId が "1".."45" という日本語版Word固有の
 *   数値IDしか無い。原稿側の表が <w:tblStyle w:val="TableGrid"/> を参照していると、
 *   参照先が解決できず **罫線が丸ごと消える**。しかも Word はエラーを出さない。
 *
 * どう解くか:
 *   罫線を新しく引く（＝作る）のではなく、原稿の styles.xml から
 *   その定義を丸ごと持ってくる（＝運ぶ）。
 *   執筆者が画面で見ていた罫線が、そのまま出力に出る。
 *
 * 段落スタイル（pStyle）は運ばない。
 *   本文・見出しの書式はテンプレのハンコで上書きするのが本アプリの仕事であり、
 *   原稿側のスタイルを持ち込むと「フォントを揃えたい」という依頼に反する。
 *   運ぶのは表スタイル・文字スタイル・番号スタイルに限る。
 */

import { allElements, attrOf, firstElement } from './xml-util.js';

/** 運んでよいスタイル種別。paragraph は意図的に除外している */
const PORTABLE_TYPES = new Set(['table', 'character', 'numbering']);

/**
 * styles.xml から styleId → 要素XML の索引を作る。
 */
export function indexStyles(stylesXml) {
  const map = new Map();
  if (!stylesXml) return map;
  for (const st of allElements(stylesXml, 'w:style')) {
    const id = attrOf(st, 'w:styleId');
    if (id) map.set(id, { xml: st, type: attrOf(st, 'w:type') });
  }
  return map;
}

/**
 * XML の中で参照されているスタイルIDを集める。
 * tblStyle / rStyle / tblStyleRowBandSize などを横断する。
 */
export function collectStyleRefs(xml) {
  const ids = new Set();
  const re = /<w:(tblStyle|rStyle|numStyleLink|styleLink)\s[^>]*w:val="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) ids.add(m[2]);
  return ids;
}

/**
 * 依存を辿って必要なスタイルを集める。
 * basedOn / link / next を再帰的に追う（basedOn が欠けると書式が半分になる）。
 */
function resolveChain(id, srcIndex, tplIndex, acc, depth = 0) {
  if (depth > 12) return;                 // 循環参照よけ
  if (acc.has(id)) return;
  if (tplIndex.has(id)) return;           // テンプレ側に既にある → 上書きしない
  const entry = srcIndex.get(id);
  if (!entry) return;
  if (!PORTABLE_TYPES.has(entry.type)) return;

  acc.set(id, entry);

  for (const tag of ['w:basedOn', 'w:link', 'w:next']) {
    const el = firstElement(entry.xml, tag);
    const ref = el ? attrOf(el, 'w:val') : null;
    if (ref) resolveChain(ref, srcIndex, tplIndex, acc, depth + 1);
  }
}

/**
 * 出力側の styles.xml に、原稿から必要なスタイルを追記する。
 *
 * @param {object} o
 *   o.templateStylesXml  テンプレの styles.xml
 *   o.sourceStylesXml    原稿の styles.xml（無ければ null）
 *   o.referencedIn       スタイル参照を探す XML（運んだ表のXMLなど）
 * @returns {{xml:string, imported:string[], missing:string[]}}
 */
export function importStyles({ templateStylesXml, sourceStylesXml, referencedIn }) {
  const refs = collectStyleRefs(referencedIn ?? '');
  if (!refs.size) return { xml: templateStylesXml, imported: [], missing: [] };

  const tplIndex = indexStyles(templateStylesXml);
  const srcIndex = indexStyles(sourceStylesXml);

  const needed = new Map();
  const missing = [];
  for (const id of refs) {
    if (tplIndex.has(id)) continue;
    if (!srcIndex.has(id)) { missing.push(id); continue; }
    resolveChain(id, srcIndex, tplIndex, needed);
  }
  if (!needed.size) return { xml: templateStylesXml, imported: [], missing };

  const insert = [...needed.values()].map(e => e.xml).join('');
  const xml = templateStylesXml.replace(/<\/w:styles>\s*$/, `${insert}</w:styles>`);
  if (xml === templateStylesXml) {
    throw new Error('styles.xml に </w:styles> が見つかりません');
  }

  return { xml, imported: [...needed.keys()], missing };
}
