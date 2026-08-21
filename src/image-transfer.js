/**
 * image-transfer.js — 画像・メディア移設の安全装置
 *
 * handoff.md B-1 の4点に対応:
 *   1. [Content_Types].xml への拡張子登録
 *   2. rId の再採番（衝突回避）
 *   3. wp:docPr/@id の一意性確保
 *   4. アスペクト比の算出元を正しく選ぶ
 *
 * 設計方針:
 *   - 「走査」は正規表現で raw string に対して行う（document.xml / header / footer /
 *     txbxContent を横断する必要があり、DOM を全部歩くより速く漏れにくい）
 *   - 「変更」は DOMParser / XMLSerializer で行う（属性の取り違えを防ぐ）
 *   - 純粋関数は Node でもテストできるよう DOM に依存させない
 */

/* ============================================================
 * 定数
 * ========================================================== */

const EMU_PER_MM = 36000;

/** 1 twip = 635 EMU（1 inch = 1440 twips = 914,400 EMU） */
const EMU_PER_TWIP = 635;

/**
 * テンプレ セクション2 の sectPr から一意に導かれる段の横寸法。
 *
 *   段抜き = pgSz.w − pgMar.left − pgMar.right = 11906 − 907 − 907 = 10092 twips
 *   片段   = (段抜き − cols.space) / 2        = (10092 − 824) / 2  = 4634 twips
 *
 * mm を経由すると丸め位置が変わるため（81.7mm → 2,941,200 EMU）、
 * twips のまま EMU へ変換する。これが唯一の正。
 */
const SECT2 = { pgW: 11906, marL: 907, marR: 907, colSpace: 824, colNum: 2 };
const SPAN_TWIPS   = SECT2.pgW - SECT2.marL - SECT2.marR;                    // 10092
const SINGLE_TWIPS = (SPAN_TWIPS - SECT2.colSpace) / SECT2.colNum;           //  4634

export const COLUMN_WIDTH_TWIPS = { single: SINGLE_TWIPS, span: SPAN_TWIPS };

export const COLUMN_WIDTH = {
  single: SINGLE_TWIPS * EMU_PER_TWIP,  // 2,942,590 EMU = 81.75 mm
  span:   SPAN_TWIPS   * EMU_PER_TWIP,  // 6,408,420 EMU = 178.01 mm
};

/** 拡張子 → ContentType。OOXML が Default で受け付ける画像形式 */
const IMAGE_CONTENT_TYPES = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  jpg:  'image/jpeg',
  gif:  'image/gif',
  bmp:  'image/bmp',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  emf:  'image/x-emf',
  wmf:  'image/x-wmf',
  svg:  'image/svg+xml',
};

const REL_TYPE_IMAGE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/* ============================================================
 * 1. [Content_Types].xml への拡張子登録
 * ========================================================== */

/**
 * 既に <Default Extension="..."> が登録されている拡張子の集合を返す。
 * @param {string} xml [Content_Types].xml の中身
 * @returns {Set<string>} 小文字の拡張子
 */
export function listDeclaredExtensions(xml) {
  const set = new Set();
  const re = /<Default\s+Extension="([^"]+)"/gi;
  let m;
  while ((m = re.exec(xml)) !== null) set.add(m[1].toLowerCase());
  return set;
}

/**
 * 不足している拡張子の <Default> を追記した [Content_Types].xml を返す。
 * 既に登録済みのものは触らない（重複させると Word が壊れる）。
 *
 * @param {string} xml       元の [Content_Types].xml
 * @param {string[]} exts    登録したい拡張子（'png' 等）
 * @returns {{xml: string, added: string[]}}
 */
export function ensureContentTypeDefaults(xml, exts) {
  const declared = listDeclaredExtensions(xml);
  const added = [];
  let inserts = '';

  for (const rawExt of exts) {
    const ext = String(rawExt).toLowerCase().replace(/^\./, '');
    if (declared.has(ext)) continue;
    const ct = IMAGE_CONTENT_TYPES[ext];
    if (!ct) {
      // 未知の拡張子は勝手に推測しない（→ 警告 W24 を上げる）
      throw new Error(`未知の画像形式です: .${ext}`);
    }
    inserts += `<Default Extension="${ext}" ContentType="${ct}"/>`;
    declared.add(ext);
    added.push(ext);
  }

  if (!inserts) return { xml, added: [] };

  // <Types ...> の直後に差し込む。Default は Override より前にあるべき。
  const out = xml.replace(/(<Types\b[^>]*>)/, `$1${inserts}`);
  if (out === xml) throw new Error('[Content_Types].xml に <Types> が見つかりません');
  return { xml: out, added };
}

/* ============================================================
 * 2. rId の再採番
 * ========================================================== */

/**
 * rels XML 中で使用済みの rId 番号の最大値を返す。
 *
 * 注意: テンプレの rels は出現順がバラバラ（rId8 が先頭にある）。
 * 「最後の要素 + 1」で採番すると衝突する。必ず最大値を取ること。
 *
 * @param {string} relsXml
 * @returns {number} 使用済みの最大番号。1つも無ければ 0
 */
export function scanMaxRIdNumber(relsXml) {
  let max = 0;
  const re = /\bId="rId(\d+)"/g;
  let m;
  while ((m = re.exec(relsXml)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * rId を払い出すアロケータ。
 * 入力docx側の rId は一切信用せず、出力側で必ず振り直す。
 */
export class RIdAllocator {
  constructor(relsXml) {
    this.next = scanMaxRIdNumber(relsXml) + 1;
    this.pending = [];
  }

  /**
   * 画像リレーションを1本追加し、新しい rId を返す。
   * @param {string} target 'media/image7.png' のような相対パス
   */
  addImage(target) {
    const id = `rId${this.next++}`;
    this.pending.push({ id, type: REL_TYPE_IMAGE, target });
    return id;
  }

  /** 追加分を反映した rels XML を返す */
  apply(relsXml) {
    if (!this.pending.length) return relsXml;
    const inserts = this.pending
      .map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
      .join('');
    const out = relsXml.replace(/(<Relationships\b[^>]*>)/, `$1${inserts}`);
    if (out === relsXml) throw new Error('rels に <Relationships> が見つかりません');
    return out;
  }
}

/* ============================================================
 * 3. wp:docPr/@id の一意性
 * ========================================================== */

/**
 * document.xml / header*.xml / footer*.xml を横断して
 * 使用済みの docPr id の最大値を返す。
 *
 * テキストボックス内（txbxContent）の docPr も拾う必要があるため、
 * DOM を歩かず raw string を正規表現で走査する。
 *
 * @param {string[]} xmlParts 走査対象の XML 文字列（複数パート）
 */
export function scanMaxDocPrId(xmlParts) {
  let max = 0;
  const re = /<(?:wp|a):docPr\b[^>]*\bid="(\d+)"/g;
  for (const xml of xmlParts) {
    let m;
    while ((m = re.exec(xml)) !== null) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    re.lastIndex = 0;
  }
  return max;
}

/** docPr id を払い出す（1から始まる正の整数でなければ Word が警告する） */
export class DocPrIdAllocator {
  constructor(xmlParts) {
    this.next = Math.max(1, scanMaxDocPrId(xmlParts) + 1);
  }
  allocate() {
    return this.next++;
  }
}

/* ============================================================
 * 4. 画像の実寸法とアスペクト比
 * ========================================================== */

/**
 * 画像バイナリの先頭からフォーマットと実ピクセル寸法を読む。
 * 再エンコードしないので、ヘッダを読むだけで足りる。
 *
 * @param {Uint8Array} bytes
 * @returns {{ext:string, mime:string, width:number|null, height:number|null}}
 */
export function sniffImage(bytes) {
  const b = bytes;
  const u16be = i => (b[i] << 8) | b[i + 1];
  const u32be = i => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16le = i => b[i] | (b[i + 1] << 8);
  const u32le = i => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

  // PNG: 89 50 4E 47 ... IHDR
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: 'png', mime: 'image/png', width: u32be(16), height: u32be(20) };
  }

  // GIF: 'GIF8'
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif', width: u16le(6), height: u16le(8) };
  }

  // BMP: 'BM'
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp', width: u32le(18), height: u32le(22) };
  }

  // JPEG: FF D8 → SOFn マーカーを探す
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // SOF0-3, 5-7, 9-11, 13-15（DHT=C4 / JPG=C8 / DAC=CC は除く）
      const isSOF =
        (marker >= 0xc0 && marker <= 0xcf) &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { ext: 'jpeg', mime: 'image/jpeg', height: u16be(i + 5), width: u16be(i + 7) };
      }
      const len = u16be(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { ext: 'jpeg', mime: 'image/jpeg', width: null, height: null };
  }

  // EMF: レコード型 1 + ' EMF' シグネチャ（オフセット40）
  if (b.length > 44 && u32le(0) === 1 &&
      b[40] === 0x20 && b[41] === 0x45 && b[42] === 0x4d && b[43] === 0x46) {
    return { ext: 'emf', mime: 'image/x-emf', width: null, height: null };
  }

  // WMF (placeable): D7 CD C6 9A
  if (b.length > 4 && b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) {
    return { ext: 'wmf', mime: 'image/x-wmf', width: null, height: null };
  }

  // TIFF: 'II*\0' or 'MM\0*'
  if (b.length > 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
       (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))) {
    return { ext: 'tiff', mime: 'image/tiff', width: null, height: null };
  }

  return { ext: null, mime: null, width: null, height: null };
}

/**
 * 出力する wp:extent の cx / cy を決める。
 *
 * アスペクト比の採用順（ここが B-1 の4点目の核心）:
 *   1. 元原稿の wp:extent（cx, cy）  ← 最優先
 *      トリミング（a:srcRect）や意図的な縦横変形が既に反映済みのため。
 *      実ピクセル寸法から計算し直すと、トリミングした画像が伸びる。
 *   2. 実ピクセル寸法
 *      元 extent が取れないとき（インライン化されていない等）のみ。
 *   3. どちらも無ければ 4:3 を仮置きし、警告を上げる。
 *
 * @param {object} o
 * @param {{cx:number, cy:number}|null} o.srcExtent 元原稿の wp:extent
 * @param {{width:number|null, height:number|null}} o.intrinsic 実ピクセル寸法
 * @param {number} o.targetCx 目標の横幅（EMU）。COLUMN_WIDTH の値を渡す
 * @returns {{cx:number, cy:number, aspectSource:string, effectiveDpi:number|null}}
 */
export function computeExtent({ srcExtent, intrinsic, targetCx }) {
  let ratio = null;          // 高さ / 幅
  let aspectSource = 'fallback';

  if (srcExtent && srcExtent.cx > 0 && srcExtent.cy > 0) {
    ratio = srcExtent.cy / srcExtent.cx;
    aspectSource = 'srcExtent';
  } else if (intrinsic && intrinsic.width > 0 && intrinsic.height > 0) {
    ratio = intrinsic.height / intrinsic.width;
    aspectSource = 'intrinsic';
  } else {
    ratio = 3 / 4;
  }

  const cx = Math.round(targetCx);
  const cy = Math.round(targetCx * ratio);

  // 有効解像度（W12 の判定に使う）: 実ピクセル幅 ÷ 配置幅(inch)
  let effectiveDpi = null;
  if (intrinsic && intrinsic.width > 0) {
    const widthInch = cx / EMU_PER_MM / 25.4;
    effectiveDpi = Math.round(intrinsic.width / widthInch);
  }

  return { cx, cy, aspectSource, effectiveDpi };
}

export function twipsToEmu(tw) {
  return Math.round(tw * EMU_PER_TWIP);
}

/**
 * 段の高さ（EMU）。これを超えたら1段に収まらない。
 * pgSz.h − pgMar.top − pgMar.bottom = 16838 − 1701 − 1701 = 13436 twips
 */
export const COLUMN_HEIGHT_EMU = twipsToEmu(16838 - 1701 - 1701); // 8,531,860 EMU = 237.0 mm

/* ============================================================
 * 統合: 1枚の画像を出力docxへ移設する
 * ========================================================== */

/**
 * @param {object} ctx 変換コンテキスト
 *   ctx.zipOut          JSZip インスタンス（出力用）
 *   ctx.contentTypesXml [Content_Types].xml の現在値（文字列）
 *   ctx.relsXml         word/_rels/document.xml.rels の現在値（文字列）
 *   ctx.rIds            RIdAllocator
 *   ctx.docPrIds        DocPrIdAllocator
 *   ctx.mediaSeq        連番カウンタ {n: number}
 *   ctx.warnings        警告を push する配列
 * @param {object} img
 *   img.bytes      Uint8Array（arraybuffer で読むこと！string で読むと壊れる）
 *   img.srcExtent  {cx, cy} | null
 *   img.width      'single' | 'span'
 *   img.name       図の呼び名（警告メッセージ用）
 * @returns {{rId:string, docPrId:number, cx:number, cy:number, target:string}}
 */
export function transferImage(ctx, img) {
  const info = sniffImage(img.bytes);

  if (!info.ext) {
    ctx.warnings.push({
      id: 'W24', level: 'warn',
      message: `${img.name} は対応していない画像形式です。PNGまたはJPEGで貼り直してください`,
    });
    return null;
  }

  if (info.ext === 'emf' || info.ext === 'wmf') {
    ctx.warnings.push({
      id: 'W25', level: 'info',
      message: `${img.name} はベクタ形式（.${info.ext}）です。Word以外での表示が崩れる場合があります`,
    });
  }

  // --- 1. Content_Types に拡張子を登録 ---
  const ct = ensureContentTypeDefaults(ctx.contentTypesXml, [info.ext]);
  ctx.contentTypesXml = ct.xml;

  // --- media/ へコピー（名前は出力側で振り直す。入力側の名前は信用しない）---
  const target = `media/image${ctx.mediaSeq.n++}.${info.ext}`;
  ctx.zipOut.file(`word/${target}`, img.bytes, { binary: true });

  // --- 2. rId を採番して rels に追加 ---
  const rId = ctx.rIds.addImage(target);

  // --- 3. docPr id を採番 ---
  const docPrId = ctx.docPrIds.allocate();

  // --- 4. 寸法を決める ---
  const targetCx = COLUMN_WIDTH[img.width] ?? COLUMN_WIDTH.single;
  const { cx, cy, aspectSource, effectiveDpi } =
    computeExtent({ srcExtent: img.srcExtent, intrinsic: info, targetCx });

  if (aspectSource === 'fallback') {
    ctx.warnings.push({
      id: 'W26', level: 'warn',
      message: `${img.name} の縦横比を判定できませんでした。4:3で配置しています。目視で確認してください`,
    });
  }

  if (effectiveDpi !== null && effectiveDpi < 150) {
    ctx.warnings.push({
      id: 'W12', level: 'warn',
      message: `${img.name} の解像度が不足しています（${effectiveDpi} dpi）。印刷時に不鮮明になる可能性があります`,
    });
  }

  return { rId, docPrId, cx, cy, target };
}

/**
 * <w:drawing><wp:inline> の XML を組み立てる。
 * ここは「作る」処理だが、器を作っているだけで中身（画像）は運んでいる。
 */
export function buildInlineDrawingXml({ rId, docPrId, cx, cy, name }) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${docPrId}" name="${esc(name)}"/>` +
      `<wp:cNvGraphicFramePr>` +
        `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
      `</wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:nvPicPr>` +
              `<pic:cNvPr id="${docPrId}" name="${esc(name)}"/>` +
              `<pic:cNvPicPr/>` +
            `</pic:nvPicPr>` +
            `<pic:blipFill>` +
              `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
              `<a:stretch><a:fillRect/></a:stretch>` +
            `</pic:blipFill>` +
            `<pic:spPr>` +
              `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
              `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
            `</pic:spPr>` +
          `</pic:pic>` +
        `</a:graphicData>` +
      `</a:graphic>` +
    `</wp:inline>` +
  `</w:drawing>`;
}
