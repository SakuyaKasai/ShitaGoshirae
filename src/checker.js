/**
 * checker.js — 投稿規程との差分を検出する
 *
 * フェーズ1の中核。docx 生成に一切依存しないため、テキストを貼るだけで動く。
 *
 * 設計の前提（handoff 7-2）:
 *   警告してよいのは「規定に明文があること」だけ。
 *   明文がない慣行（図表キャプションの配置など）には触れない。
 *
 * 各チェックは { id, level, message, count, fixes } を返す。
 *   level: 'error' | 'warn' | 'info'
 *   fixes: [{ start, end, before, after }]  ← 文字オフセット。プレビューと一括適用に使う
 */

import { detectHeading, analyzeHeadings } from './heading-detect.js';

/* ============================================================
 * 共通ユーティリティ
 * ========================================================== */

/** 参考文献セクションの開始位置（行番号）。無ければ null */
export function findReferenceSection(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^[\s\u3000]*(文[\s\u3000]*献|参考文献|References?)[\s\u3000]*$/.test(lines[i])) {
      return i;
    }
  }
  return null;
}

/** 行配列 → 各行の先頭文字オフセット */
function lineOffsets(lines) {
  const offs = [];
  let pos = 0;
  for (const line of lines) {
    offs.push(pos);
    pos += line.length + 1;   // +1 は改行
  }
  return offs;
}

/* ============================================================
 * W01 / W02 — 句読点
 * ========================================================== */

/**
 * 句点「。」読点「、」の検出。規定は「．」「，」。
 *
 * 除外:
 *   - 引用符・括弧内の固有名詞などは区別できないため除外しない（件数で判断してもらう）
 *   - URL 内のドットは対象外（そもそも「。」ではない）
 */
export function checkPunctuation(text) {
  const results = [];

  for (const [id, from, to, name] of [
    ['W01', '。', '．', '句点'],
    ['W02', '、', '，', '読点'],
  ]) {
    const fixes = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === from) {
        fixes.push({ start: i, end: i + 1, before: from, after: to });
      }
    }
    if (fixes.length) {
      results.push({
        id, level: 'warn', autoFix: true, count: fixes.length,
        message: `${name}が「${from}」の箇所が ${fixes.length}件 あります。規定では「${to}」です`,
        fixes,
      });
    }
  }
  return results;
}

/* ============================================================
 * W15 — 数字と単位の間の半角スペース
 * ========================================================== */

/** SI単位系と慣用単位。長いものから並べる（最長一致のため） */
const UNITS = [
  'mmHg', 'kcal', 'km/h', 'm/s2', 'm/s', 'rpm', 'dpi', 'bpm',
  'kHz', 'MHz', 'GHz', 'kPa', 'MPa', 'GPa', 'kΩ', 'MΩ',
  'kg', 'mg', 'μg', 'ng', 'km', 'cm', 'mm', 'μm', 'nm',
  'ms', 'μs', 'ns', 'mL', 'dL', 'kN', 'mN', 'mV', 'kV', 'mA', 'μA',
  'Hz', 'Pa', 'lx', 'cd', 'sr', 'mol', 'lm', 'Wb', 'kJ', 'MJ',
  'g', 'm', 's', 'A', 'K', 'N', 'J', 'W', 'V', 'Ω', 'L', 'T', 'C', 'F', 'H',
];

const UNIT_ALT = UNITS.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/**
 * `32kHz` → `32 kHz`。
 *
 * 誤爆させないための除外:
 *   - 年号 "2024年"、序数、変数名（"F1", "T2"）
 *   - 単位の直後に英字が続く場合（"3mm四方" はOK、"3may" は単位でない）
 */
export function checkUnitSpacing(text) {
  const fixes = [];
  // 数値全体を捉える（メッセージ表示のため。"32kHz" を "2kHz" と出さない）
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)(${UNIT_ALT})(?![A-Za-z0-9])`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    // 直前が英字なら変数名の可能性（"xF1" 等）
    const prev = text[m.index - 1];
    if (prev && /[A-Za-z]/.test(prev)) continue;
    const at = m.index + m[1].length;
    fixes.push({ start: at, end: at, before: '', after: ' ',
                 context: `${m[1]}${m[2]} → ${m[1]} ${m[2]}` });
  }
  if (!fixes.length) return [];
  return [{
    id: 'W15', level: 'info', autoFix: true, count: fixes.length,
    message: `数字と単位の間に半角スペースがない箇所が ${fixes.length}件 あります（例: ${fixes[0].context}）`,
    fixes,
  }];
}

/* ============================================================
 * W07 — Unicode の数式文字
 * ========================================================== */

/**
 * 数式ツールで書くべき文字。ベタ書きされているとフォント依存で化ける。
 *
 * 信号の強さを2段階に分ける:
 *   STRONG — 演算子・上下付き文字。1個あれば数式とみなしてよい
 *   WEAK   — ギリシャ文字。"α波" のように本文で普通に使われるため、
 *            単独では数式と判断しない（2個以上、または STRONG との併用で発火）
 */
const MATH_STRONG = new RegExp('[' +
  '\\u2070-\\u209C' +          // 上付き・下付き数字
  '\\u1D62-\\u1D6A' +          // 下付きラテン文字（ᵢ ᵣ ᵤ ᵥ ...）
  '\\u2C7C\\u2071' +           // 下付き j, 上付き i
  '\\u2200-\\u22FF' +          // 数学記号（∫ ∑ ∏ √ ∂ ∇ ≠ ≤ ≥ ∈ ...）
  '\\u27C0-\\u27EF\\u2A00-\\u2AFF' +
  '\\u00D7\\u00F7\\u00B1\\u221A\\u221E' +
  ']', 'g');

const MATH_WEAK = /[\u0391-\u03A9\u03B1-\u03C9]/g;

export function checkMathChars(lines) {
  const hits = [];
  lines.forEach((line, i) => {
    const strong = line.match(MATH_STRONG) || [];
    const weak = line.match(MATH_WEAK) || [];
    MATH_STRONG.lastIndex = 0; MATH_WEAK.lastIndex = 0;

    // 強い信号が1つでもあれば数式。弱い信号だけなら2つ以上で数式
    if (strong.length === 0 && weak.length < 2) return;

    const chars = [...new Set([...strong, ...weak])].join('');
    hits.push({ line: i + 1, text: line.trim().slice(0, 40), chars });
  });
  if (!hits.length) return [];
  return [{
    id: 'W07', level: 'warn', autoFix: false, count: hits.length,
    message: `数式の可能性がある行が ${hits.length}件 あります。Wordの数式ツールで作成してください`,
    detail: hits.map(h => `${h.line}行目: ${h.text}（${h.chars}）`),
  }];
}

/* ============================================================
 * W05 / W06 — 引用と文献の対応
 * ========================================================== */

/**
 * 参考文献リストの番号を拾う。
 * リストは「文献」見出し以降にあり、各行が "N)" または "N." で始まる。
 */
export function collectReferences(lines, refStart) {
  const refs = [];
  if (refStart === null) return refs;
  for (let i = refStart + 1; i < lines.length; i++) {
    const m = /^[\s\u3000]*(\d+)[)）.．][\s\u3000]*(.+)$/.exec(lines[i]);
    if (m) refs.push({ num: parseInt(m[1], 10), line: i + 1, text: m[2].slice(0, 50) });
  }
  return refs;
}

/**
 * 本文中の引用番号を拾う。
 *
 * 限界（handoff 12-3）: `1)` が引用か箇条書きかは判定できない。
 * ここでは「行頭でない N)」だけを引用候補とする。行頭のものは箇条書きの可能性が高い。
 */
export function collectCitations(lines, refStart) {
  const cites = new Set();
  const end = refStart === null ? lines.length : refStart;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    const re = /(\d+(?:\s*[,，]\s*\d+)*)\s*[)）]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      // 行頭（前が空白のみ）なら箇条書きとみなして除外
      const before = line.slice(0, m.index);
      if (!before.trim()) continue;
      // 直前が「（」なら注記の可能性（"（1）" は既に括弧付き）
      if (/[（(]$/.test(before)) continue;
      for (const n of m[1].split(/[,，]/)) {
        const v = parseInt(n.trim(), 10);
        if (Number.isFinite(v)) cites.add(v);
      }
    }
  }
  return cites;
}

export function checkCitations(lines) {
  const results = [];
  const refStart = findReferenceSection(lines);
  if (refStart === null) return results;

  const refs = collectReferences(lines, refStart);
  if (!refs.length) return results;

  const cited = collectCitations(lines, refStart);

  // W05: リストにあるが本文から引用されていない
  const uncited = refs.filter(r => !cited.has(r.num));
  if (uncited.length) {
    results.push({
      id: 'W05', level: 'warn', autoFix: false, count: uncited.length,
      message: `本文から引用されていない文献が ${uncited.length}件 あります: ${uncited.map(r => `${r.num})`).join(', ')}`,
      detail: uncited.map(r => `文献${r.num}) ${r.text}`),
    });
  }

  // W06: 本文にあるが文献リストに無い
  const refNums = new Set(refs.map(r => r.num));
  const dangling = [...cited].filter(n => !refNums.has(n)).sort((a, b) => a - b);
  if (dangling.length) {
    results.push({
      id: 'W06', level: 'warn', autoFix: false, count: dangling.length,
      message: `本文の引用番号に対応する文献がありません: ${dangling.map(n => `${n})`).join(', ')}`,
    });
  }

  // 文献番号の連番チェック
  const nums = refs.map(r => r.num);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) {
      results.push({
        id: 'W06', level: 'info', autoFix: false, count: 1,
        message: `文献リストの番号が連続していません（${nums[i - 1]}) の次が ${nums[i]})）`,
      });
      break;
    }
  }

  return results;
}

/* ============================================================
 * W16 / W17 — 英文タイトルと著者名
 * ========================================================== */

/**
 * 規定のストップワード。テンプレ本文の列挙に「など」が付くため閉じた集合ではない。
 * 代表的なものから始め、運用で追加する（handoff 7-3）。
 */
export const STOP_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'or', 'but', 'nor', 'for', 'if', 'while', 'since', 'as', 'that', 'when',
  'at', 'by', 'in', 'of', 'on', 'to', 'from', 'with', 'into', 'over', 'than',
  'up', 'off', 'out', 'per', 'via', 'vs',
]);

/**
 * 英文タイトルのキャピタライゼーションを検査する。
 *
 * 規定: 原則は各単語の頭文字を大文字。冠詞・接続詞・前置詞・不定詞は小文字。
 * 実装上の例外（規定に書かれていない）:
 *   - 先頭語は冠詞でも大文字（テンプレ見本自体がそう）
 *   - ハイフン語の後半は慣行に従い大文字。ただし警告しない（W18）
 */
export function checkEnglishTitle(title) {
  if (!title || !title.trim()) return [];
  const results = [];
  const fixes = [];

  const words = title.split(/(\s+)/);
  let wordIndex = 0;
  let offset = 0;

  for (const token of words) {
    if (/^\s+$/.test(token)) { offset += token.length; continue; }

    const isFirst = wordIndex === 0;
    const bare = token.replace(/[^A-Za-z'-]/g, '');
    const lower = bare.toLowerCase();

    if (bare && /[A-Za-z]/.test(bare)) {
      const shouldBeLower = !isFirst && STOP_WORDS.has(lower);
      const firstChar = token.search(/[A-Za-z]/);
      const ch = token[firstChar];

      if (shouldBeLower && ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
        fixes.push({
          start: offset + firstChar, end: offset + firstChar + 1,
          before: ch, after: ch.toLowerCase(),
          context: `${token} → ${token[firstChar].toLowerCase()}${token.slice(firstChar + 1)}`,
        });
      } else if (!shouldBeLower && ch === ch.toLowerCase() && ch !== ch.toUpperCase()) {
        fixes.push({
          start: offset + firstChar, end: offset + firstChar + 1,
          before: ch, after: ch.toUpperCase(),
          context: `${token} → ${token[firstChar].toUpperCase()}${token.slice(firstChar + 1)}`,
        });
      }
    }

    offset += token.length;
    wordIndex++;
  }

  if (fixes.length) {
    results.push({
      id: 'W16', level: 'warn', autoFix: true, count: fixes.length,
      message: `英文タイトルの大文字・小文字が規定と異なる箇所が ${fixes.length}件 あります（${fixes.map(f => f.context).join(' / ')}）`,
      fixes,
    });
  }

  // W18: ハイフン語は情報のみ
  const hyphenated = title.match(/\b[A-Za-z]+-[A-Za-z]+\b/g);
  if (hyphenated) {
    results.push({
      id: 'W18', level: 'info', autoFix: false, count: hyphenated.length,
      message: `ハイフンを含む語があります（${hyphenated.join(', ')}）。ハイフン後の大文字化は規定に記載がないため、現状のままにします`,
    });
  }

  return results;
}

/**
 * 英文著者名の姓が全て大文字か検査する。
 * 規定: 英文氏名については，姓(Family name)のみ大文字で記載する
 *
 * @param {string[]} names ['Yuri AOKI', 'Miho KASAI']
 */
export function checkEnglishAuthors(names) {
  if (!names || !names.length) return [];
  const bad = [];

  for (const name of names) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const family = parts[parts.length - 1];
    const letters = family.replace(/[^A-Za-z]/g, '');
    if (!letters) continue;
    if (letters !== letters.toUpperCase()) {
      bad.push({ name, family, suggest: parts.slice(0, -1).join(' ') + ' ' + family.toUpperCase() });
    }
  }

  if (!bad.length) return [];
  return [{
    id: 'W17', level: 'warn', autoFix: true, count: bad.length,
    message: `英文氏名は姓のみ全て大文字で記載します（${bad.map(b => `${b.name} → ${b.suggest}`).join(' / ')}）`,
    fixes: bad.map(b => ({ before: b.name, after: b.suggest })),
  }];
}

/* ============================================================
 * W10 — キーワード数
 * ========================================================== */

export function checkKeywords(keywords) {
  if (!keywords) return [];
  const n = keywords.filter(k => k && k.trim()).length;
  if (n === 5 || n === 0) return [];
  return [{
    id: 'W10', level: 'info', autoFix: false, count: 1,
    message: `キーワードが ${n}個 です（テンプレートの見本は5個）`,
  }];
}

/* ============================================================
 * W22 — 2文字見出しの全角スペース
 * ========================================================== */

/** テンプレの組版慣行に合わせるべき無番号見出し */
const SECTION_LABELS = ['文献', '謝辞', '付記', '方法', '結果', '考察', '結論', '緒言', '序論'];

export function checkTwoCharHeadings(lines) {
  const fixes = [];
  const offs = lineOffsets(lines);

  lines.forEach((line, i) => {
    const t = line.trim();
    if (SECTION_LABELS.includes(t)) {
      const at = offs[i] + line.indexOf(t);
      fixes.push({
        start: at, end: at + t.length,
        before: t, after: `${t[0]}\u3000${t[1]}`,
        context: `${t} → ${t[0]}　${t[1]}`,
      });
    }
  });

  if (!fixes.length) return [];
  return [{
    id: 'W22', level: 'info', autoFix: true, count: fixes.length,
    message: `2文字の見出しが ${fixes.length}件 あります。テンプレートでは字間を開けます（${fixes[0].context}）`,
    fixes,
  }];
}

/* ============================================================
 * 統合
 * ========================================================== */

/**
 * テキスト原稿を一括でチェックする。
 *
 * @param {string} text 本文（改行区切り）
 * @param {object} meta フォーム入力（任意）
 *   meta.englishTitle    英文タイトル
 *   meta.englishAuthors  英文著者名の配列
 *   meta.keywords        キーワードの配列
 * @returns {{results:Array, summary:object}}
 */
export function runChecks(text, meta = {}) {
  const lines = String(text).split(/\r?\n/);
  const results = [];

  results.push(...checkPunctuation(text));
  results.push(...checkUnitSpacing(text));
  results.push(...checkMathChars(lines));
  results.push(...checkCitations(lines));
  results.push(...checkTwoCharHeadings(lines));

  const h = analyzeHeadings(lines);
  results.push(...h.warnings.map(w => ({ ...w, level: w.level || 'warn', count: w.count || 1 })));

  if (meta.englishTitle) results.push(...checkEnglishTitle(meta.englishTitle));
  if (meta.englishAuthors) results.push(...checkEnglishAuthors(meta.englishAuthors));
  if (meta.keywords) results.push(...checkKeywords(meta.keywords));

  const order = { error: 0, warn: 1, info: 2 };
  results.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));

  return {
    results,
    headings: h.headings,
    summary: {
      error: results.filter(r => r.level === 'error').length,
      warn: results.filter(r => r.level === 'warn').length,
      info: results.filter(r => r.level === 'info').length,
      autoFixable: results.filter(r => r.autoFix === true).length,
      totalFixes: results.reduce((n, r) => n + (r.fixes ? r.fixes.length : 0), 0),
    },
  };
}

/* ============================================================
 * 自動修正の適用
 * ========================================================== */

/**
 * 選択した修正を適用する。
 *
 * 後ろから適用することで、前方のオフセットがずれない。
 * これを前から適用すると2件目以降が確実にずれる（典型的なバグ）。
 *
 * @param {string} text
 * @param {Array} fixes  { start, end, after } を持つ配列
 */
export function applyFixes(text, fixes) {
  const sorted = [...fixes].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) {
    if (typeof f.start !== 'number') continue;
    out = out.slice(0, f.start) + f.after + out.slice(f.end);
  }
  return out;
}

/** 指定した ID の修正だけをまとめて適用する */
export function applyFixesById(text, results, ids) {
  const wanted = new Set(ids);
  const fixes = [];
  for (const r of results) {
    if (wanted.has(r.id) && r.fixes) fixes.push(...r.fixes);
  }
  return applyFixes(text, fixes);
}
