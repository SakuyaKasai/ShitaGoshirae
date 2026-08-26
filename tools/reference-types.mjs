/**
 * reference-types.mjs — SIST02 の書式定義（テンプレ「文　献」節の写し）
 *
 *   build-manifest.mjs から読み込まれ、manifest.json の `references` へ埋め込まれる。
 *   アプリ実行時は manifest 経由でのみ参照する（このファイルは runtime に載らない）。
 *
 * 設計意図:
 *   ここに書いてあるのは「アプリが考えた書式」ではなく、
 *   テンプレート本文に明文で列挙されている書式の転記である。
 *   したがって build-manifest はテンプレ側に該当節が存在するかを毎回検査し、
 *   見つからなければ警告する（学会がテンプレを改訂した合図になる）。
 *
 *   「作らない、運ぶ、警告する」— ここで作るのは書式ではなく、書式の写しである。
 *
 * ------------------------------------------------------------------
 * 組み立てモデル
 * ------------------------------------------------------------------
 *   各 type は fields[] を持つ。fields は「フォームの並び順」であり
 *   「出力の並び順」でもある（2つを別々に持つと必ず食い違う）。
 *
 *   1フィールドの出力  = prefix + 値 + suffix
 *   値が空ならフィールドごと消える（区切りも残らない）。required でも同じ。
 *   出力に ［出版者］ のような穴埋め記号は入れない —
 *   アプリは原稿に無い文字を書かない。空欄は「書けなかった」であって「書く場所」ではない。
 *
 *   required は出力ではなく報告に効く:
 *     required: true  → R01 として未入力を報告する。UI は該当欄を赤くする
 *     required: false → 何も言わない
 *
 *   区切り記号は「直前に出力されたフィールドの follow」を使う。
 *   ただし後続側が lead を持つ場合はそちらが優先される。
 *
 *     例: 書籍で 版表示 が空のとき
 *         著者名(follow=period) 書名(follow=period) [版表示(follow=comma) 省略] 出版地
 *         → 直前に出力されたのは書名なので period が使われる
 *         → 「…ガイドライン．東京，共立出版，…」  ← テンプレ例示と一致
 *
 *     例: 論文で DOI があるとき
 *         ページ(follow=comma) DOI(lead=period)
 *         → lead が優先され「…p. 1-10．https://doi.org/…」  ← 規定の形式行と一致
 *
 *   区切りを付けた結果、半角の「.」「,」と全角の「．」「，」が隣り合うことがある
 *   （"et al." + "．" → "et al.．"）。半角ピリオドは略記や頭文字の一部で
 *   機械的に区別できないため削らず、R02 として位置つきで報告する。
 *   UI はプレビュー中の該当位置をハイライトする — 文章で場所を説明しない。
 *
 *   末尾には type.terminal の区切りが付く。
 *   ただし最後に出力されたフィールドが suppressTerminal を持つ場合は付けない
 *   （URL の直後にピリオドを置くとリンクに巻き込まれるため）。
 *
 * ------------------------------------------------------------------
 * 全角/半角について
 * ------------------------------------------------------------------
 *   テンプレートは形式定義行が全角（著者名．論文名．）、例示行が半角（, . ）で
 *   書かれており、それ自体が矛盾している。さらに書籍の例示は1行の中で
 *   全角と半角が混在する（…ガイドライン. 東京，共立出版，2003，139p.）。
 *
 *   本アプリは形式定義行を正とし全角に統一する（PO 判断）。
 *   切り替えは delimiters の2行を書き換えるだけで済む。
 *     半角にする場合: period: '. ', comma: ', '  ← 末尾スペース込みで持つこと
 *
 *   ただし以下は意図的に半角のまま残す:
 *     - "p. " …… page の略記。句読点ではない
 *     - "p."  …… 総ページ数の単位（139p.）
 *     - "(参照 …)" …… テンプレ例示が半角括弧
 *     - standardColon …… "ISO 9241-210:2010" は規格の正式名称の一部であり、
 *                        ここを全角にすると規格番号そのものが別物になる
 */

/** 名前付き区切り記号。fields の follow / lead はこのキーを指す */
export const DELIMITERS = {
  period: '．',
  comma: '，',
  colon: '：',
  standardColon: ':',
};

export const REFERENCE_TYPES = [
  /* ========================================================== 1 */
  {
    id: 'journal',
    label: '論文・雑誌',
    marker: '＜論文・雑誌の場合＞',
    spec: '著者名．論文名．誌名．出版年，巻数，号数，はじめのページ-おわりのページ. https://doi.org/DOI番号',
    examples: [
      '大須賀美恵子, 青木和夫, 他. 座談会－ネットで語る人間工学の来し方行く先－. 人間工学. 2014, 50(1), p. 1-10. https://doi.org/10.5100/jje.50.1',
      'Dul, J.; Bruder, R.; et al. A strategy for human factors/ergonomics: Developing the discipline and profession. Ergonomics. 2012, 55(4), p. 377-395. https://doi.org/10.1080/00140139.2012.661087',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period',
        hint: '英文は姓のみ記載し名はイニシャル。3名以上は2名まで書いて et al.' },
      { key: 'title', label: '論文名', required: true, follow: 'period' },
      { key: 'journal', label: '誌名', required: true, follow: 'period',
        hint: '略記ではなく正式名称。英文は各単語の頭を大文字（前置詞等は除く）' },
      { key: 'year', label: '出版年', required: true, follow: 'comma', autofill: 'year' },
      { key: 'volume', label: '巻(号)', required: true, follow: 'comma', autofill: 'volume',
        hint: '50(1) の形。号がなければ 50 だけでも可' },
      { key: 'pages', label: 'ページ', required: false, follow: 'comma', autofill: 'pages',
        prefix: 'p. ', hint: '1-10' },
      { key: 'articleNo', label: '記事番号', required: false, follow: 'comma',
        hint: 'ページのない電子雑誌などの場合に記入' },
      { key: 'doi', label: 'DOI', required: false, lead: 'period', autofill: 'doi',
        prefix: 'https://doi.org/', suppressTerminal: true,
        hint: '10.5100/jje.50.1 の形。URL ごと貼り付けても構いません' },
    ],
  },

  /* ========================================================== 2 */
  {
    id: 'specialIssue',
    label: '特集記事中の1記事',
    marker: '＜特集記事中の1記事の場合＞',
    spec: '著者名．特集標題：論文名．誌名．出版年，巻数，号数，はじめのページ-おわりのページ．',
    examples: [
      'French, J. C.; Chapin, A. C.; et al. Special topic section, Document search interface design for large-scale collections: Multiple viewpoints as an approach to digital library interfaces. Journal of the Association for Information Science and Technology. 2004, 55(10), p. 911-922. https://doi.org/10.1002/asi.20035',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period' },
      { key: 'specialTitle', label: '特集標題', required: true, follow: 'colon',
        hint: 'この型では「：」が正しい区切りです（本文の句読点ルールとは別）' },
      { key: 'title', label: '論文名', required: true, follow: 'period' },
      { key: 'journal', label: '誌名', required: true, follow: 'period' },
      { key: 'year', label: '出版年', required: true, follow: 'comma', autofill: 'year' },
      { key: 'volume', label: '巻(号)', required: true, follow: 'comma', autofill: 'volume' },
      { key: 'pages', label: 'ページ', required: false, follow: 'comma', autofill: 'pages',
        prefix: 'p. ' },
      { key: 'doi', label: 'DOI', required: false, lead: 'period', autofill: 'doi',
        prefix: 'https://doi.org/', suppressTerminal: true },
    ],
  },

  /* ========================================================== 3 */
  {
    id: 'proceedings',
    label: 'Proceedings・講演集',
    marker: '＜Proceedings・講演集の場合＞',
    spec: '著者名．“論文名”．会議報告書名．会議開催地，会議開催期間，会議主催機関名，出版者，出版年，はじめのページ-おわりのページ.',
    examples: [
      '青木和夫. “日本人間工学会の歴史と現状”. 人間工学. 神戸市, 2014-06-05/06, 日本人間工学会, 2014, p. S8-S9.',
      'Ebara, T.; Yoshitake, R.; et al. “Impact of Ergonomics good practices database as public relations tools”. International Ergonomics Association: Proceedings of 17th World congress on Ergonomics. Beijing, China, 2009-08-09/14.',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period' },
      { key: 'title', label: '論文名', required: true, follow: 'period',
        prefix: '“', suffix: '”' },
      { key: 'proceedingsName', label: '会議報告書名', required: true, follow: 'period' },
      { key: 'venue', label: '会議開催地', required: false, follow: 'comma',
        hint: '東京の場合は省略できます' },
      { key: 'period', label: '会議開催期間', required: false, follow: 'comma',
        hint: '2014-06-05/06 の形' },
      { key: 'organizer', label: '会議主催機関名', required: false, follow: 'comma',
        hint: '出版者と同一なら省略できます' },
      { key: 'publisher', label: '出版者', required: false, follow: 'comma' },
      { key: 'year', label: '出版年', required: false, follow: 'comma', autofill: 'year',
        hint: '会議開催年と同一なら省略できます' },
      { key: 'pages', label: 'ページ', required: false, follow: 'comma', autofill: 'pages',
        prefix: 'p. ', hint: 'CD-ROM などの電子媒体では任意' },
      { key: 'doi', label: 'DOI', required: false, lead: 'period', autofill: 'doi',
        prefix: 'https://doi.org/', suppressTerminal: true },
    ],
  },

  /* ========================================================== 4 */
  {
    id: 'book',
    label: '書籍（1冊）',
    marker: '＜書籍（1冊）の場合＞',
    spec: '著者名．書名．版表示，出版地，出版者，出版年，総ページ数．',
    examples: [
      '日本人間工学会編．ユニバーサルデザイン実践ガイドライン. 東京，共立出版，2003，139p.',
      'Ningen, J. Book Title. Ergonomics Press, 2017, 200p.',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period',
        hint: '編者の場合は「日本人間工学会編」のように「編」まで含めて記入' },
      { key: 'bookTitle', label: '書名', required: true, follow: 'period' },
      { key: 'edition', label: '版表示', required: false, follow: 'comma',
        hint: '1st ed. / 第2版 など。初版なら空欄' },
      { key: 'place', label: '出版地', required: false, follow: 'comma',
        hint: '原著に記載がなければ空欄のままにしてください（推測して埋めない）' },
      { key: 'publisher', label: '出版者', required: true, follow: 'comma' },
      { key: 'year', label: '出版年', required: true, follow: 'comma', autofill: 'year' },
      { key: 'totalPages', label: '総ページ数', required: false, follow: 'comma',
        suffix: 'p', hint: '139 と入力すると 139p．になります' },
      { key: 'doi', label: 'DOI', required: false, lead: 'period', autofill: 'doi',
        prefix: 'https://doi.org/', suppressTerminal: true },
    ],
  },

  /* ========================================================== 5 */
  {
    id: 'bookChapter',
    label: '書籍（章）',
    marker: '＜書籍の場合＞',
    spec: '著者名．“章の見出し”．書名．編者名．版表示，出版地，出版者，出版年，はじめのページ-おわりのページ．',
    examples: [
      '人間太郎．“章の見出し”．人間工学実践ガイドライン．日本人間工学会編. 東京，日本人間工学会，2017，p.1-10．',
      'Ningen, T. “Chapter title”. Book Title. 1st ed., Ergonomics Press, 2017, p.1-10.',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period' },
      { key: 'chapterTitle', label: '章の見出し', required: true, follow: 'period',
        prefix: '“', suffix: '”' },
      { key: 'bookTitle', label: '書名', required: true, follow: 'period' },
      { key: 'editor', label: '編者名', required: false, follow: 'period',
        hint: '著者と編者が同一なら空欄' },
      { key: 'edition', label: '版表示', required: false, follow: 'comma' },
      { key: 'place', label: '出版地', required: false, follow: 'comma' },
      { key: 'publisher', label: '出版者', required: true, follow: 'comma' },
      { key: 'year', label: '出版年', required: true, follow: 'comma', autofill: 'year' },
      { key: 'pages', label: 'ページ', required: false, follow: 'comma', autofill: 'pages',
        prefix: 'p. ' },
      { key: 'doi', label: 'DOI', required: false, lead: 'period', autofill: 'doi',
        prefix: 'https://doi.org/', suppressTerminal: true },
    ],
  },

  /* ========================================================== 6 */
  {
    id: 'online',
    label: 'オンライン資料・Webページ',
    marker: '＜オンライン上の電子資料・コンテンツの場合＞',
    spec: '著者名．“ウェブページの題名”．ウェブサイトの名称．入手先，(入手日付)．',
    examples: [
      '日本人間工学会テレワークガイド委員会. “2010年版ノートパソコン利用の人間工学ガイドライン”. http://www.ergonomics.jp/product/guideline.html, (参照 2012-10-19).',
      '日本人間工学会. “人間工学とは－人間工学の概説”. http://www.ergonomics.jp/outline.html, (参照2021-04-01).',
    ],
    terminal: 'period',
    fields: [
      { key: 'authors', label: '著者名', required: true, follow: 'period',
        hint: '団体名でも構いません' },
      { key: 'pageTitle', label: 'ウェブページの題名', required: true, follow: 'period',
        prefix: '“', suffix: '”' },
      { key: 'siteName', label: 'ウェブサイトの名称', required: false, follow: 'period',
        hint: 'テンプレートの例示では省略されています' },
      { key: 'url', label: '入手先', required: true, follow: 'comma', autofill: 'url' },
      { key: 'accessDate', label: '入手日付', required: true, autofill: 'accessDate',
        prefix: '(参照 ', suffix: ')', hint: '2021-04-01 の形' },
    ],
  },

  /* ========================================================== 7 */
  {
    id: 'standard',
    label: '規格（ISO / JIS など）',
    marker: '＜ISO/JISなどの規格文書の場合＞',
    spec: '規格番号：制定年．規格標題．',
    examples: [
      'ISO 9241-210:2010. Ergonomics of human-system interaction -- Part 210: Human-centred design for interactive systems.',
    ],
    terminal: 'period',
    fields: [
      { key: 'standardNo', label: '規格番号', required: true, follow: 'standardColon',
        hint: 'ISO 9241-210 / JIS Z 8530 など' },
      { key: 'year', label: '制定年', required: true, follow: 'period', autofill: 'year' },
      { key: 'standardTitle', label: '規格標題', required: true },
    ],
  },
];

/**
 * テンプレ本文に各型の見出しが今も存在するか検査する。
 * 学会がテンプレを改訂して書式が変わった場合、ここで気づける。
 *
 * @param {string} templateText  テンプレ全段落のテキストを連結したもの
 * @returns {{ok:boolean, missing:string[]}}
 */
export function verifyAgainstTemplate(templateText) {
  const squash = s => s.replace(/[\s\u3000]+/g, '');
  const hay = squash(templateText);
  const missing = REFERENCE_TYPES
    .filter(t => !hay.includes(squash(t.marker)))
    .map(t => `${t.label}（${t.marker}）`);
  return { ok: missing.length === 0, missing };
}
