/**
 * heading-detect.js — 見出し番号の正規化とレベル判定
 *
 * 方針:
 *   - 原稿側のスタイル（pStyle）は一切見ない。番号だけで判定する
 *   - 表記ゆれ（全角/半角、区切り記号、スペース混入）を正規化してから判定する
 *   - 判定できない行は本文とみなす（誤検出より取りこぼしを選ぶ）
 *
 * なぜスタイルを見ないか:
 *   Googleドキュメントの原稿では、見た目だけで見出しを作る人（フォントを大きく
 *   して太字にしただけ）はスタイルが Normal のままで、逆に本文がうっかり
 *   Heading になっていることもある。番号に一本化すれば優先順位の判断が不要。
 */

/* ============================================================
 * 文字レベルの正規化
 * ========================================================== */

/** 全角英数字・記号 → 半角 */
export function toHalfWidth(s) {
  return s
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');   // 全角スペース → 半角
}

/** 各種のダッシュ・ハイフン類 → 半角ハイフン */
export function normalizeDashes(s) {
  return s.replace(/[\u2010-\u2015\u2212\uFF0D\u30FC\u2043\uFE63]/g, '-');
}

/** 各種のピリオド類 → 半角ドット */
export function normalizePeriods(s) {
  return s.replace(/[\uFF0E\u3002\u00B7\u2027]/g, '.');
}

/**
 * 見出し番号部分の正規化。
 * 「１．２ 」「1 . 2.」「１-２ 」などをすべて "1.2" に畳む。
 */
export function normalizeNumberToken(token) {
  let s = toHalfWidth(token);
  s = normalizeDashes(s);
  s = normalizePeriods(s);
  s = s.replace(/\s+/g, '');        // 番号内の空白は全部落とす（"1 . 2" → "1.2"）
  s = s.replace(/[-.]+$/, '');      // 末尾の区切りを落とす（"1.2." → "1.2"）
  s = s.replace(/[.-]+/g, '.');     // 区切りをドットに統一（"1-2" → "1.2"）
  return s;
}

/* ============================================================
 * 見出し行の判定
 * ========================================================== */

/**
 * 番号らしき先頭部分を切り出すパターン。
 *
 * 想定する入力（すべて同じ 1.2 として扱う）:
 *   "1.2 図表の作り方"   "1．2　図表の作り方"   "１-２. 図表の作り方"
 *   "1-2.図表の作り方"   "1 . 2 図表の作り方"
 *
 * 除外したいもの:
 *   "2024.4.1 改定"      年月日
 *   "1) 新しい発見"      箇条書き・引用番号
 *   "3.5 kg の重り"      本文中の数値
 */
const NUMBER_HEAD = /^[\s\u3000]*([0-9０-９]+(?:[\s\u3000]*[-.\uFF0E\u3002\u2010-\u2015\u2212\uFF0D][\s\u3000]*[0-9０-９]+)*)[\s\u3000]*([.\uFF0E\u3002][\s\u3000]*|[\s\u3000]+)(.*)$/;

/** 章番号として妥当な範囲か（年号や測定値を弾く） */
function isPlausibleChapterNumber(parts) {
  if (parts.length === 0 || parts.length > 4) return false;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return false;
    if (n < 0 || n > 99) return false;     // 章番号が3桁になることはない
    if (p.length > 2) return false;         // "2024" を弾く
  }
  if (parseInt(parts[0], 10) === 0) return false;  // "0." 始まりは章番号でない
  return true;
}

/**
 * 1行を判定する。
 *
 * @param {string} line
 * @returns {{
 *   isHeading: boolean,
 *   level: number|null,      // 1..4
 *   number: string|null,     // 正規化後 "2.1"
 *   parts: number[]|null,    // [2, 1]
 *   title: string|null,      // 見出し文字列
 *   raw: string,
 *   confidence: 'high'|'medium'|'low'
 * }}
 */
export function detectHeading(line) {
  const raw = line;
  const miss = { isHeading: false, level: null, number: null, parts: null,
                 title: null, raw, confidence: 'high' };

  const text = String(line).replace(/\s+$/, '');
  if (!text.trim()) return miss;

  // 箇条書き・引用番号 "1)" "(1)" は見出しではない
  if (/^[\s\u3000]*[(（]?[0-9０-９]+[)）]/.test(text)) return miss;

  const m = NUMBER_HEAD.exec(text);
  if (!m) return miss;

  const number = normalizeNumberToken(m[1]);
  const parts = number.split('.').filter(Boolean);
  if (!isPlausibleChapterNumber(parts)) return miss;

  const title = m[3].trim();
  if (!title) return miss;                       // 番号だけの行は見出しにしない

  // 見出しらしさの検査
  let confidence = 'high';

  // 句点で終わる行は本文の可能性が高い（"3.5 kg を測定した．"）
  if (/[.．。]$/.test(title)) confidence = 'low';

  // 極端に長い行は本文
  if (title.length > 60) confidence = 'low';

  // 単位が続く場合は測定値（"3.5 kg の重り"）
  if (/^(?:[a-zA-Zμ%°]{1,3})(?:[\s\u3000]|$)/.test(title)) confidence = 'low';

  if (confidence === 'low') return miss;

  // 区切りなしのスペース区切りだけの場合はやや弱い（"1 はじめに"）
  if (!/[.\uFF0E\u3002]/.test(m[2])) confidence = 'medium';

  return {
    isHeading: true,
    level: Math.min(parts.length, 4),
    number,
    parts: parts.map(p => parseInt(p, 10)),
    title,
    raw,
    confidence,
  };
}

/* ============================================================
 * 文書全体の走査と整合性チェック
 * ========================================================== */

/**
 * 行の配列を走査して見出し一覧と警告を返す。
 *
 * @param {string[]} lines
 * @returns {{headings:Array, warnings:Array, stats:object}}
 */
export function analyzeHeadings(lines) {
  const headings = [];
  const warnings = [];

  let referenceSectionAt = null;

  lines.forEach((line, i) => {
    // 「文献」見出し以降は見出し判定を止める（"1)" の誤爆対策）
    if (referenceSectionAt === null &&
        /^[\s\u3000]*(文[\s\u3000]*献|参考文献|References?)[\s\u3000]*$/.test(line)) {
      referenceSectionAt = i;
    }
    if (referenceSectionAt !== null && i > referenceSectionAt) return;

    const h = detectHeading(line);
    if (h.isHeading) headings.push({ ...h, index: i });
  });

  // --- W03: 記法ゆれ ---
  const styles = new Set();
  for (const h of headings) {
    const t = h.raw.trim();
    const sep = /[０-９]/.test(t) ? 'fullwidth-num'
              : /[．。]/.test(t.slice(0, 8)) ? 'fullwidth-dot'
              : /-/.test(t.slice(0, 8)) ? 'hyphen'
              : 'halfwidth-dot';
    styles.add(sep);
  }
  if (styles.size > 1) {
    warnings.push({
      id: 'W03', level: 'warn', autoFix: true,
      message: `見出し番号の書き方が揃っていません（${styles.size}種類の記法が混在）。統一しますか？`,
    });
  }

  // --- W04: 重複・欠番 ---
  const seen = new Map();
  for (const h of headings) {
    if (seen.has(h.number)) {
      warnings.push({
        id: 'W04', level: 'warn', autoFix: 'confirm',
        message: `番号 ${h.number} が2回使われています（${seen.get(h.number)}行目と${h.index + 1}行目）`,
      });
    } else {
      seen.set(h.number, h.index + 1);
    }
  }

  // 同階層での連番の飛び
  const byParent = new Map();
  for (const h of headings) {
    const parent = h.parts.slice(0, -1).join('.');
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(h);
  }
  for (const [parent, group] of byParent) {
    const nums = group.map(g => g.parts[g.parts.length - 1]);
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] > nums[i - 1] + 1) {
        const missing = [];
        for (let n = nums[i - 1] + 1; n < nums[i]; n++) {
          missing.push(parent ? `${parent}.${n}` : String(n));
        }
        warnings.push({
          id: 'W04', level: 'warn', autoFix: 'confirm',
          message: `見出し番号が飛んでいます: ${missing.join(', ')} がありません`,
        });
      }
    }
  }

  // --- 階層の飛び越し（1 の次にいきなり 1.1.1）---
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      warnings.push({
        id: 'W29', level: 'info',
        message: `見出し ${headings[i].number} の階層が飛んでいます（${headings[i - 1].number} の次）`,
      });
    }
  }

  // --- 3階層を超えるもの ---
  const deep = headings.filter(h => h.level >= 4);
  if (deep.length) {
    warnings.push({
      id: 'W30', level: 'info',
      message: `4階層以上の見出しが${deep.length}件あります（テンプレートは3階層までを想定）`,
    });
  }

  return {
    headings,
    warnings,
    stats: {
      total: headings.length,
      byLevel: [1, 2, 3, 4].map(l => headings.filter(h => h.level === l).length),
      medium: headings.filter(h => h.confidence === 'medium').length,
      referenceSectionAt,
    },
  };
}

/* ============================================================
 * 出力用の番号整形
 * ========================================================== */

/**
 * 正規化した番号を、テンプレの表記に戻す。
 * テンプレは 見出し1 = "1. " / 見出し2 = "2-1. " という表記。
 */
export function formatNumber(parts) {
  if (parts.length === 1) return `${parts[0]}. `;
  return `${parts.join('-')}. `;
}

/** 2文字の見出しに全角スペースを入れる（W22 / テンプレの組版慣行） */
export function applyKintouWariduke(title) {
  const t = title.trim();
  if (t.length === 2 && !/[a-zA-Z0-9]/.test(t)) {
    return `${t[0]}\u3000${t[1]}`;
  }
  return t;
}
