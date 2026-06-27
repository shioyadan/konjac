# Konjac Agent Guide

Konjac は、PDF を解析して論文向けのプレーンな HTML として表示する Chrome 拡張です。Chrome 拡張と CLI は同じ抽出エンジンを共有しており、抽出ロジックの変更はまず CLI で `work` 以下の PDF を変換して確認します。

この文書は、このリポジトリで作業するエージェント向けに、全体構造、検証手順、デバッグ方法、作業上の注意点をまとめたものです。

## リポジトリ概要

PDF.js で PDF の text content と描画オブジェクトを取り出し、タイトル、見出し、段落、図表、キャプション、参照リンクなどの構造を推定します。

同じ抽出エンジンを Chrome 拡張と CLI で共有しています。抽出精度を直すときは、拡張上で試す前に CLI で対象 PDF を変換して確認します。

## 大まかな構造

- `extractor.ts`: PDF の構造抽出の中心。本文行、見出し、図表、キャプション、リンク、HTML 生成の多くがここにある。
- `viewer.ts`: Chrome 拡張の viewer。PDF を読み込み、`extractor.ts` の結果を DOM と図表画像へ変換する。
- `main.ts`: Chrome 拡張の service worker。コンテキストメニューから viewer を開く。
- `cli.ts`: CLI 変換。Chrome を使わず、同じ抽出エンジンで HTML/JSON/debug 出力を作る。
- `Makefile`: 拡張ビルド、CLI ビルド、CLI 変換の入口。
- `manifest.json`, `viewer.html`: Chrome 拡張として必要なファイル。
- `work/`: 手元検証用の PDF と変換結果。大量の一時出力はなるべく `/tmp` を使う。
- `dist/`: webpack の出力。通常は `make` / `make cli-build` で生成される。

## 基本方針

- PDF 個別の特化処理は避ける。特定の論文名、図番号、本文の語句に依存した判定は入れない。
- なるべくレイアウト、フォント、行間、bbox、PDF の描画オブジェクトなど、文書一般に使える情報で判定する。
- 実装はコンパクトに保つ。古い補正や使われなくなった helper は残さない。
- `extractor.ts` に処理を追加するときは、既存の抽出フローに沿って局所的に入れる。
- 変更後は `npx tsc --noEmit` と CLI 変換を確認する。拡張に影響する変更では `make` も確認する。

## よく使うコマンド

```sh
make cli-build
PDF=work/<target>.pdf
make cli PDF="$PDF" OUT="${PDF%.pdf}.current.html"
make cli-json PDF="$PDF" JSON_OUT="${PDF%.pdf}.current.json"
npx tsc --noEmit
make
```

`make cli` は HTML を出す。図表画像も埋め込むので、見た目の確認に使う。

`make cli-json` は抽出ノードを JSON で出す。タイトル、段落、図表、bbox、リンクなどの構造確認に使う。

`make` は Chrome 拡張として必要なファイルを `dist` に出す。拡張側に影響する変更では最後に実行する。

## PDF テストの流れ

1. まず対象 PDF を 1 つに絞る。

   ```sh
   PDF=work/<target>.pdf
   make cli-json PDF="$PDF" JSON_OUT="${PDF%.pdf}.current.json"
   make cli PDF="$PDF" OUT="${PDF%.pdf}.current.html"
   ```

2. JSON でノード種別と順序を確認する。

   - 見出しが適切な type になっているか
   - 段落が図表やキャプションをまたいで不自然に分断・結合されていないか
   - 図表ノードの caption と `rect` が対応しているか
   - references や cite/link が消えていないか

3. HTML でレンダリング結果を見る。

   - 図や表が切れていないか
   - 前後の本文を巻き込んでいないか
   - caption の位置と整列が自然か
   - itemize / enumerate が本文に吸われていないか

4. 局所修正のあと、`work` 以下の複数の PDF で同じ確認を行う。図表検出や段落結合など共有ロジックに触れた場合は、`work/*.pdf` を一通り回す。

   ```sh
   for PDF in work/*.pdf; do
       make cli-json PDF="$PDF" JSON_OUT="${PDF%.pdf}.current.json"
   done
   ```

5. 最後に型検査とビルドを行う。

   ```sh
   npx tsc --noEmit
   make
   ```

## 図表検出のデバッグ

図表の bbox が怪しいときは、mask SVG と scan log を使う。

```sh
make cli-build
PDF=work/<target>.pdf
BASE="${PDF%.pdf}"
node dist/cli.cjs --json --debug-mask "${BASE}.debug-mask" "$PDF" > "${BASE}.current.json"
node dist/cli.cjs --json --debug-scan "<caption text>" "$PDF" > "${BASE}.current.json" 2> "${BASE}.debug.log"
```

- `--debug-mask <dir>` はページごとの mask SVG を出す。本文、caption、shape、除外された shape などの領域確認に使う。
- `--debug-scan <caption-text>` は指定 caption 近傍のスキャンログを stderr に出す。図表の上下左右境界がどこで止まったかを見る。
- debug 出力は調査用であり、必要がなければコミットしない。

## 拡張としての確認

拡張に必要なファイルは `make` で `dist` に出る。

```sh
make
```

Chrome では `dist` を unpacked extension として読み込む。ローカル PDF を直接扱う場合は、Chrome の拡張設定で「ファイルの URL へのアクセスを許可」が必要になる。

## 作業上の注意

- `work/*.current.*` は検証用の出力として使う。既存の `work/*.json` / `work/*.html` を更新する必要があるときだけ差分を残す。
- 生成物や debug dump を大量に増やさない。必要なら `/tmp` に出す。
- ユーザーの未コミット変更を巻き戻さない。
- コミットはユーザーから明示されたときだけ行う。
