# Konjac

Konjac は、PDF を解析して論文向けのプレーンな HTML として表示する Chrome 拡張です。タイトル、見出し、段落、図表、キャプション、参照リンクなどを PDF のレイアウトから推定します。同じ抽出エンジンをコマンドラインからも利用できます。

## Chrome 拡張として使う

Node.js、npm、Google Chrome が必要です。

```sh
npm install
make
```

1. Chrome で `chrome://extensions` を開く。
2. 「デベロッパー モード」を有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリの `dist` ディレクトリを選ぶ。
4. PDF 上で右クリックし、「View PDF」を選ぶ。

ローカルの PDF を開く場合は、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可」を有効にしてください。

## CLI として使う

PDF を HTML に変換します。

```sh
make cli PDF="work/input.pdf" OUT="work/output.html"
```

抽出結果を JSON で確認することもできます。

```sh
make cli-json PDF="work/input.pdf" JSON_OUT="work/output.json"
```

開発・デバッグ手順の詳細は [AGENTS.md](AGENTS.md) を参照してください。
