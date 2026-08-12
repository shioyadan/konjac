# Konjac

Konjac は、PDF を解析して論文向けのプレーンな HTML として表示する Chrome 拡張です。タイトル、見出し、段落、図表、キャプション、参照リンクなどを PDF のレイアウトから推定します。同じ抽出エンジンをコマンドラインからも利用できます。

## ビルド

Node.js と npm が必要です。

```sh
npm install
make
```

生成物は用途ごとに分かれます。

- `dist/extension`: Chrome 拡張
- `dist/web/index.html`: 単一HTMLのWeb版
- `dist/cli`: CLI

個別に生成する場合は、`make extension-build`、`make web-build`、`make cli-build` を使います。

配布用ZIPを生成する場合は、次を実行します。

```sh
make package
```

`dist/packages/konjac-web.zip` と `dist/packages/konjac-extension.zip` が生成されます。

ソースコードは用途別に分かれています。

- `src/core`: 共通の抽出・表示ロジック
- `src/extension`: Chrome 拡張
- `src/cli`: CLI
- `src/web`: 単一HTMLのWeb版

## Chrome 拡張として使う

1. Chrome で `chrome://extensions` を開く。
2. 「デベロッパー モード」を有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリの `dist/extension` ディレクトリを選ぶ。
4. PDF 上で右クリックし、「View PDF」を選ぶ。
5. 表示結果を保存する場合は、「Export HTML」を押す。

対応するデスクトップ版 Chrome では、「Translate to Japanese」で文書を日本語へ翻訳できます。翻訳後は文書全体または段落ごとに原文を併記できます。初回は Chrome が翻訳用の言語パックをダウンロードすることがあります。

ローカルの PDF を開く場合は、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可」を有効にしてください。

## Webページとして使う

`dist/web/index.html` をブラウザで直接開きます。JavaScript、PDF.js Worker、CMapはこのHTMLに埋め込まれているため、別のファイルやHTTPサーバーは不要です。ローカルPDFをドラッグ＆ドロップするか、「Choose a PDF」で選択できます。

GitHub PagesへデプロイされたWeb版は、[https://shioyadan.github.io/konjac/](https://shioyadan.github.io/konjac/) から直接利用できます。

## CLI として使う

PDF を HTML に変換します。

```sh
make cli PDF="work/input.pdf" OUT="work/output.html"
```

抽出結果を JSON で確認することもできます。

```sh
make cli-json PDF="work/input.pdf" JSON_OUT="work/output.json"
```

CLI本体を直接実行する場合のパスは `dist/cli/cli.cjs` です。

## CIと配布

GitHub Actionsはpush、pull request、手動実行時に型検査とWeb版・Chrome拡張のビルドを行います。生成された2つのZIPは、各workflow runの`konjac-packages` artifactから取得できます。

`master`へのpushまたは`master`上での手動実行では、`dist/web/index.html`をGitHub Pagesへ配置し、通常のWebページとして直接参照できるようにします。GitHub側ではリポジトリのSettings → Pages → Sourceを「GitHub Actions」に設定してください。

`v`から始まるタグをpushすると、同じZIPを添付したGitHub Releaseを作成します。

開発・デバッグ手順の詳細は [AGENTS.md](AGENTS.md) を参照してください。
