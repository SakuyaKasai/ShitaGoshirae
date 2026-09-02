# 原稿したごしらえ（jes-formatter）

論文原稿を、日本人間工学会『人間工学』誌 **技術報告**テンプレートの体裁へ整えるWebアプリ。

ブラウザ内で完結する。原稿は外部へ送信されない。

- 利用者向けの説明 → [`使い方.md`](./使い方.md)
- 設計と経緯 → [`handoff.md`](./handoff.md)

---

## 設計原則

> **作らない、運ぶ、警告する。**
>
> アプリは新しいものを生成しない。入力にあるものをそのまま運び、運べないものは警告する。

図・表・数式・参考文献の扱いは、すべてこの一文から導ける。生成処理が存在しなければ、崩れようがない。

テンプレートは **Wordスタイルを一切使っていない**（`pStyle` 使用回数 0、全216段落が直接書式）。したがって「スタイルを当てる」方式は使えず、テンプレ本文から抽出した直接書式を**ハンコとして複製する**。

---

## 配布と実行

配布物は **`index.html` 1ファイル**（約360KB）。テンプレ `.docx` を base64 で同梱しているので、静的ホスティングに置くだけで動く。ビルド環境もサーバも要らない。

```bash
npm install
npm run manifest   # template.docx → src/manifest.json
npm test           # 242件
npm run build      # → index.html
```

**`npm run build` はリポジトリの配布物を更新するためのもので、テストの前提ではない。** `npm test` はブラウザテスト用に、いまのソースから `.testwork/index.html` を自前で焼いて、そちらを開く。したがって build を忘れてもテストは正しく落ちる（作業ツリーの `index.html` にも触らない）。

**既定ブランチは `dev`。** 作業は `dev` で行い、`main` への PR がマージされると GitHub Actions が manifest 生成 → テスト → ビルドを回して生成物を書き戻す。したがって **`dev` の `index.html` と `manifest.json` はソースより古いのが正常**。配布物の中身を見るときは main 側を見ること。

開発中は `src/app.js` を直接読み込む形でも動くが、`manifest.json` と テンプレの base64 が要るため、`npm run build` 経由が早い。

---

## 構成

```
index.html              配布物。これ1つで動く
template.docx           学会配布のテンプレ原本
src/
  xml-util.js           XMLのバランス取り出し・属性・エスケープ
  source-parse.js       原稿docx → ブロック列
  extract-meta.js       表題・著者・抄録・キーワードの推定
  heading-detect.js     見出し判定・番号正規化
  checker.js            規定チェックと自動修正
  image-transfer.js     画像移設・ID採番・寸法スナップ
  numbering-merge.js    番号定義のマージ
  style-import.js       原稿から表スタイル定義を運ぶ
  compose.js            ハンコ押し・表の幅調整・所属差し替え
  pipeline.js           変換の一本道
  reference-format.js   参考文献の組み立て・フィールド抽出・種別推定
  reference-guide.js    参考文献のガイド編集モーダル
  app.js                画面
  app.css               画面のスタイル（ガイド編集の rg- 節もここに同居させる）
  manifest.json         テンプレ固有値（生成物）
tools/
  build-manifest.mjs    テンプレ → manifest.json
  build-bundle.mjs      → index.html
  reference-types.mjs   参考文献7種の書式定義（テンプレ「文　献」節の転記）
  make-fixture.py       検証用原稿（本文の問題を再現）
  make-fixture-full.py  検証用原稿（表題付き）
test/
  run-all.mjs           全テストのランナー
.github/workflows/
  build.yml             manifest 生成 → テスト → 配布物ビルド → 生成物の書き戻し
```

**CSS を別ファイルに分けないこと。** `build-bundle.mjs` は `src/app.css` だけをインライン化するため、別ファイルの CSS は `index.html` に入らない。モーダルが `position: fixed` にならずページ下部に並ぶ、という分かりにくい壊れ方をする。

---

## 変換の流れ

```
テンプレ.docx ─┐
原稿.docx    ─┴→ 解析 → チェック → ハンコ押し → 再パッケージ → 出力.docx + 指摘

  セクション1（1段組・表題/抄録）… フォーム入力から組む
  セクション2（2段組・行番号）  … 原稿のブロック列にハンコを押す
  所属テキストボックス          … ページ下端へ付け替えて差し込む
```

出力ZIPはテンプレの複製として作り、必要なパートだけ差し替える。消すより残すほうが安全。

---

## 設計上の判断

### mammoth.js を使わない

mammoth は docx → HTML の変換器で、HTML に落とした時点で `w:tbl` の罫線定義、`m:oMath` の数式XML、`wp:extent` の配置寸法が失われる。「運ぶ」原則と正面衝突するため、JSZip で開いて生XMLのまま持ち回る。

### DOMParser / XMLSerializer を使わない

XMLSerializer は名前空間宣言を付け直す。`mc:AlternateContent` を含む run を再直列化すると Word が開けなくなることがある。切り出しは文字列走査、書き換えは対象を限定した置換で行う。

### テンプレ固有値は manifest.json へ

セクション境界・ハンコ・numId・寸法をコードに埋め込まない。学会がテンプレを改訂したら `npm run manifest` の再実行だけで追随できる。

セクション境界も**インデックス決め打ちではなく**、`sectPr` を持つ段落を探して求めている。

---

## 検証

生成した `.docx` は毎回 XSD で検証すること。Word は不正なXMLに対して「読み取り不能」としか言わないため、機械検証がないと原因特定に時間が溶ける。

```bash
python3 office/validate.py out.docx --original template.docx
soffice --headless --convert-to pdf out.docx   # 目視用
```

ブラウザ側の落とし穴（File API / atob / Blob / localStorage 不可）は Node のテストでは踏まないため、`test/ui_test.mjs` が実 Chromium で配布物そのものを開いて通しで確かめる。

---

## 既知の制約

- **PDF書き出しは Windows で行う。** Mac には ＭＳ明朝・ＭＳゴシック・メイリオが無い
- 図表の最終的な配置は人間が行う（段抜き／片段の判断は内容依存のため）
- 参考文献の**構造解析**（著者名・誌名・巻号への自動分解）は行わない。7種の書式に沿った組み立てと、区切り記号の統一は「ガイド編集」で支援する（切るのは人間、運ぶのがアプリ）
- 見出し番号の自動振り直しは行わない（本文中の相互参照を壊す恐れがあるため）
- 実原稿での検証は未実施。検証はすべて自作の fixture による
