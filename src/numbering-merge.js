/**
 * numbering-merge.js — 原稿のリスト定義をテンプレへ取り込む
 *
 * 背景:
 *   テンプレは numId を 1〜21、abstractNumId を 0〜20 まで使用済み。
 *   原稿の numPr をそのまま運ぶと確実に衝突する（rId とまったく同じ構造）。
 *
 * 方針:
 *   - 原稿側の ID にオフセットを足して再採番する
 *   - 実際に使われている numId だけ取り込む（未使用定義は捨てる）
 *   - テンプレに存在しないスタイルへの参照は落とす（ぶら下がり参照を作らない）
 *   - nsid は振り直す（同じ nsid の異なるリストがあると Word が混乱する）
 *
 * 注意: numbering.xml のスキーマは順序を強制する。
 *       すべての <w:abstractNum> が、すべての <w:num> より前になければならない。
 */

/* ============================================================
 * 走査
 * ========================================================== */

/**
 * numbering.xml の使用済み ID を調べる。
 * @returns {{maxAbstractNumId:number, maxNumId:number,
 *            abstractNumIds:Set<number>, numIds:Set<number>}}
 */
export function scanNumberingIds(xml) {
  const abstractNumIds = new Set();
  const numIds = new Set();

  let m;
  const reA = /<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"/g;
  while ((m = reA.exec(xml)) !== null) abstractNumIds.add(parseInt(m[1], 10));

  const reN = /<w:num\b[^>]*\bw:numId="(\d+)"/g;
  while ((m = reN.exec(xml)) !== null) numIds.add(parseInt(m[1], 10));

  return {
    maxAbstractNumId: abstractNumIds.size ? Math.max(...abstractNumIds) : -1,
    maxNumId: numIds.size ? Math.max(...numIds) : 0,
    abstractNumIds,
    numIds,
  };
}

/**
 * 本文 XML から実際に参照されている numId を集める。
 * txbxContent 内も拾うため raw string を走査する。
 */
export function collectUsedNumIds(...xmlParts) {
  const used = new Set();
  const re = /<w:numId\s+w:val="(\d+)"/g;
  for (const xml of xmlParts) {
    let m;
    while ((m = re.exec(xml)) !== null) used.add(parseInt(m[1], 10));
    re.lastIndex = 0;
  }
  // numId=0 は「リスト解除」の予約値。取り込み対象にしない
  used.delete(0);
  return used;
}

/* ============================================================
 * 要素の切り出し
 * ========================================================== */

/**
 * トップレベル要素を切り出す。
 * <w:abstractNum> も <w:num> も入れ子にならないため、非貪欲マッチで安全。
 */
function extractElements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

function attrOf(chunk, name) {
  const m = new RegExp(`\\b${name}="(\\d+)"`).exec(chunk);
  return m ? parseInt(m[1], 10) : null;
}

/** nsid は8桁の16進。衝突を避けるため振り直す */
function freshNsid(seed) {
  const v = ((seed * 2654435761) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return v.slice(0, 8);
}

/* ============================================================
 * マージ本体
 * ========================================================== */

/**
 * 原稿の numbering.xml をテンプレへ取り込む。
 *
 * @param {object} o
 * @param {string} o.templateXml テンプレの word/numbering.xml
 * @param {string} o.sourceXml   原稿の word/numbering.xml（無ければ null）
 * @param {Set<number>} o.usedNumIds 原稿本文で実際に使われている numId
 * @returns {{xml:string, numIdMap:Map<number,number>, imported:number, warnings:Array}}
 */
export function mergeNumbering({ templateXml, sourceXml, usedNumIds }) {
  const warnings = [];
  const numIdMap = new Map();

  if (!sourceXml || !usedNumIds || usedNumIds.size === 0) {
    return { xml: templateXml, numIdMap, imported: 0, warnings };
  }

  const tpl = scanNumberingIds(templateXml);
  const offsetA = tpl.maxAbstractNumId + 1;
  const offsetN = tpl.maxNumId + 1;

  const srcAbstracts = extractElements(sourceXml, 'w:abstractNum');
  const srcNums = extractElements(sourceXml, 'w:num');

  // numId → abstractNumId の対応を作る
  const numToAbstract = new Map();
  for (const chunk of srcNums) {
    const numId = attrOf(chunk, 'w:numId');
    const am = /<w:abstractNumId\s+w:val="(\d+)"/.exec(chunk);
    if (numId !== null && am) numToAbstract.set(numId, parseInt(am[1], 10));
  }

  // 実際に使われている numId が指す abstractNumId だけを取り込む
  const neededAbstract = new Set();
  for (const numId of usedNumIds) {
    const a = numToAbstract.get(numId);
    if (a === undefined) {
      warnings.push({
        id: 'W28', level: 'warn',
        message: `箇条書きの定義が見つかりませんでした（リスト ${numId}）。段落として出力します`,
      });
      continue;
    }
    neededAbstract.add(a);
  }

  const newAbstracts = [];
  let seed = 1;
  for (const chunk of srcAbstracts) {
    const oldId = attrOf(chunk, 'w:abstractNumId');
    if (oldId === null || !neededAbstract.has(oldId)) continue;

    let c = chunk;
    // 1. abstractNumId を再採番
    c = c.replace(/(<w:abstractNum\b[^>]*\bw:abstractNumId=")\d+(")/,
                  `$1${oldId + offsetA}$2`);
    // 2. nsid を振り直す（同一 nsid の別リストは Word が同じものとみなす）
    c = c.replace(/<w:nsid\s+w:val="[^"]*"\s*\/>/,
                  `<w:nsid w:val="${freshNsid(seed++ + oldId)}"/>`);
    // 3. テンプレに無いスタイルへの参照を落とす
    c = c.replace(/<w:pStyle\s+w:val="[^"]*"\s*\/>/g, '');
    c = c.replace(/<w:numStyleLink\s+w:val="[^"]*"\s*\/>/g, '');
    c = c.replace(/<w:styleLink\s+w:val="[^"]*"\s*\/>/g, '');
    // 4. durableId は文書内で一意である必要があるため落とす
    c = c.replace(/\s+w16cid:durableId="[^"]*"/g, '');

    newAbstracts.push(c);
  }

  const newNums = [];
  for (const chunk of srcNums) {
    const oldNumId = attrOf(chunk, 'w:numId');
    if (oldNumId === null || !usedNumIds.has(oldNumId)) continue;
    const oldAbstract = numToAbstract.get(oldNumId);
    if (oldAbstract === undefined || !neededAbstract.has(oldAbstract)) continue;

    let c = chunk;
    c = c.replace(/(<w:num\b[^>]*\bw:numId=")\d+(")/, `$1${oldNumId + offsetN}$2`);
    c = c.replace(/(<w:abstractNumId\s+w:val=")\d+(")/, `$1${oldAbstract + offsetA}$2`);
    c = c.replace(/\s+w16cid:durableId="[^"]*"/g, '');
    newNums.push(c);
    numIdMap.set(oldNumId, oldNumId + offsetN);
  }

  if (!newAbstracts.length && !newNums.length) {
    return { xml: templateXml, numIdMap, imported: 0, warnings };
  }

  // --- 挿入。abstractNum は num より前でなければならない ---
  let out = templateXml;
  const lastAbstractEnd = out.lastIndexOf('</w:abstractNum>');
  if (lastAbstractEnd >= 0) {
    const at = lastAbstractEnd + '</w:abstractNum>'.length;
    out = out.slice(0, at) + newAbstracts.join('') + out.slice(at);
  } else {
    out = out.replace(/(<w:numbering\b[^>]*>)/, `$1${newAbstracts.join('')}`);
  }

  const closeAt = out.lastIndexOf('</w:numbering>');
  if (closeAt < 0) throw new Error('numbering.xml に </w:numbering> がありません');
  out = out.slice(0, closeAt) + newNums.join('') + out.slice(closeAt);

  return { xml: out, numIdMap, imported: newNums.length, warnings };
}

/* ============================================================
 * 本文側の張り替え
 * ========================================================== */

/**
 * 本文の <w:numId w:val="N"/> を新 ID に張り替える。
 *
 * 一度に置換すると「新IDが既存の旧IDと一致して二重変換される」事故が起きるため、
 * 単一パスのコールバック置換で行う（Map を引くのは常に元の値）。
 */
export function remapNumPr(xml, numIdMap) {
  if (!numIdMap || numIdMap.size === 0) return xml;
  return xml.replace(/<w:numId\s+w:val="(\d+)"\s*\/>/g, (whole, n) => {
    const oldId = parseInt(n, 10);
    const newId = numIdMap.get(oldId);
    return newId === undefined ? whole : `<w:numId w:val="${newId}"/>`;
  });
}

/* ============================================================
 * テンプレ既定のリスト（マージ不要で使えるもの）
 * ========================================================== */

/**
 * テンプレが元から持っているリスト定義。
 * 原稿に numbering.xml が無い場合や、意図的にテンプレへ揃えたい場合に使う。
 */
export const TEMPLATE_LISTS = {
  bullet:    { numId: 1,  format: 'bullet',  sample: '●'  }, // List Bullet / Wingdings
  reference: { numId: 17, format: 'decimal', sample: '1)' }, // 参考文献
  criteria:  { numId: 14, format: 'decimal', sample: '1)' }, // 評価基準（ゴシック太字）
};

/** 参考文献段落に押すハンコ */
export function referenceNumPrXml() {
  return `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${TEMPLATE_LISTS.reference.numId}"/></w:numPr>`;
}
