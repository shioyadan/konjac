# Konjac

Konjacは、論文PDFを解析し、読みやすいプレーンなHTMLへ再構成するツールです。PDFの文字とレイアウトからタイトル、見出し、段落、図表、キャプション、参照リンクなどを推定します。

インストール不要のWeb版、閲覧中のPDFを開けるChrome拡張、HTMLやJSONを生成できるCLIがあり、すべて同じ抽出エンジンを共有しています。

## クイックスタート

1. **[Konjac Webを開きます](https://shioyadan.github.io/konjac/)**
2. PDFをページへドロップするか、「Choose a PDF」から選択します。

PDFはブラウザ内で処理され、サーバーへアップロードされません。対応ブラウザでは「Translate to Japanese」で翻訳でき、「Export HTML」で図表を埋め込んだ単一HTMLとして保存できます。

## 主な機能

- 論文PDFをタイトル、見出し、段落、リスト、図表、数式、参考文献を含むHTMLへ変換
- 抽出した段落や図表と元PDFの該当領域を並べて確認
- Chrome・Edgeの組み込み翻訳による、マシンローカルな日本語翻訳と原文併記
- 図表を埋め込んだ単一HTMLのexport
- 外部翻訳に使える、画像を含まない翻訳JSONのimport/export
- 同じ抽出エンジンをWeb版、Chrome拡張、CLIで利用

## ブラウザ版

### Web版

通常は[公開Web版](https://shioyadan.github.io/konjac/)を使用します。ローカルで使う場合は、ビルド後の`dist/web/index.html`を直接開けます。JavaScript、PDF.js Worker、CMapはHTML内に埋め込まれているため、別ファイルやHTTPサーバーは不要です。

File System Access APIに対応するChrome・Edgeでは、「Choose a PDF」で開いたファイルを「Recent files」から開き直せます。履歴は最大10件で、ブラウザ内にファイル名とファイルハンドルだけを保存します。PDF本体は保存しません。ドラッグ＆ドロップや非対応ブラウザで開いたファイルは履歴に追加されません。

WSL上の`file://wsl.localhost/...`では、保存済みファイルハンドルへ正常にアクセスできないため「Recent files」は無効になります。GitHub Pages版、localhost、または`Z:\work\konjac\dist\web\index.html`のようなWindows側のパスを使用してください。通常のPDF選択と表示はWSLの`file:` URLでも利用できます。

### Chrome拡張

1. `make extension-build`を実行します。
2. Chromeで`chrome://extensions`を開き、「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」から`dist/extension`を選択します。
4. PDF上で右クリックし、「View PDF」を選択します。

ローカルPDFを扱う場合は、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可」を有効にしてください。読み込みに成功したPDFは「Recent files」に最大10件表示されます。履歴はブラウザ内だけに保存され、PDF本体は複製されません。

### Web版・拡張の共通操作

- 各段落や図表の「PDF」で、元PDFの該当領域を表示できます。
- 複数ブロックを選ぶと「PDF selection」が現れ、該当範囲をページごとにまとめて表示します。
- PDF上の枠はドラッグと右下のハンドルで調整できます。「Show image」でHTML表示を元PDFの画像へ切り替え、「Show HTML」または「Restore image」で戻せます。
- PDF表示はドラッグで移動、`Ctrl+wheel`で拡大縮小、右下のハンドルで高さを変更できます。
- デスクトップ版Google Chrome 138以降またはMicrosoft Edge 148以降では、「Translate to Japanese」で英語から日本語へ翻訳できます。初回は言語パックをダウンロードすることがあります。
- 翻訳後は、文書全体または段落ごとに原文の表示を切り替えられます。
- 「Export HTML」は、その時点の翻訳、原文表示、図表を単独で開けるHTMLへ保存します。

## 翻訳JSON

翻訳JSONを使うと、Konjacの外部で翻訳を作成し、Web版、Chrome拡張、CLIへ戻せます。

1. PDFを開き、「Export translation JSON」を選択します。
2. `*.translation.json`の`blocks[].translation`だけを編集します。
3. 同じPDFに「Import translation JSON」で読み込みます。
4. 内容を確認し、「Export HTML」で図表入りHTMLを保存します。

`source`、`id`、`type`など、`translation`以外のフィールドは変更しないでください。import時にはPDF fingerprint、ブロック数、ID、種別を検証するため、別のPDFや構造が変わったJSONは読み込めません。

`blocks[].source`だけが原文と異なる場合は、ブロックIDで照合して読み込みを続けます。不一致の件数と該当ID（先頭5件まで）をWeb版・拡張では画面上に、CLIでは標準エラー出力に警告として表示します。警告が出た場合は、翻訳が対応する原文に合っているか確認してください。

翻訳JSONに図表画像は含まれません。図表内に画像として描かれた文字も翻訳対象外です。CLIの抽出確認用JSONとは別の形式です。

## CLI

最初に依存パッケージをインストールします。

```sh
npm install
```

通常は`bin/konjac`を使用します。

| 操作 | コマンド | 既定の出力 |
| --- | --- | --- |
| HTML生成 | `bin/konjac html work/input.pdf` | `work/input.html` |
| 抽出結果JSON | `bin/konjac json work/input.pdf` | `work/input.json` |
| 翻訳JSONのexport | `bin/konjac translation-json work/input.pdf` | `work/input.translation.json` |
| 翻訳JSONのimport | `bin/konjac import work/input.pdf work/input.translation.json` | `work/input.translated.html` |

出力先は最後の引数または`-o`で変更できます。`-o -`は標準出力、`--force`は既存ファイルの上書きです。`json`には`extract-json`という別名もあります。

```sh
bin/konjac import work/input.pdf work/input.translation.json work/input.ja.html
bin/konjac json work/input.pdf -o -
bin/konjac html --force work/input.pdf
```

パスワード付きPDFでは`KONJAC_PDF_PASSWORD`または`--password`を使用します。

```sh
KONJAC_PDF_PASSWORD="password" bin/konjac html work/input.pdf
bin/konjac html --password "password" work/input.pdf
```

図表検出の調査には`--debug-mask <dir>`と`--debug-scan <caption-text>`を使用できます。全オプションは`bin/konjac --help`で確認できます。

`bin/konjac`はCLIが未ビルドなら`make cli-build`を実行します。ビルド後のCLI本体は`dist/cli/cli.cjs`、シェルフロントエンドのコピーは`dist/cli/konjac`です。

Makeターゲットからも同じ処理を実行できます。

```sh
make cli PDF="work/input.pdf" OUT="work/input.html"
make cli-json PDF="work/input.pdf" JSON_OUT="work/input.json"
make cli-translation-json PDF="work/input.pdf" TRANSLATION_JSON_OUT="work/input.translation.json"
make cli-import PDF="work/input.pdf" TRANSLATION_JSON_IN="work/input.translation.json" TRANSLATED_HTML_OUT="work/input.ja.html"
```

## ビルドと配布

Node.jsとnpmが必要です。

```sh
npm install
make
```

| 出力 | 内容 |
| --- | --- |
| `dist/web/index.html` | 単一HTMLのWeb版 |
| `dist/extension` | Chrome拡張 |
| `dist/cli` | Node.js CLIとシェルフロントエンド |

個別にビルドする場合は`make web-build`、`make extension-build`、`make cli-build`を使用します。

ローカルWebサーバーは`make web-serve`で起動します。既定URLは[http://localhost:8765/](http://localhost:8765/)です。待ち受け先は`WEB_HOST`と`WEB_PORT`で変更できます。

`make package`は次の配布用ZIPを生成します。

- `dist/packages/konjac-web.zip`
- `dist/packages/konjac-extension.zip`

## CIとリリース

GitHub Actionsはpush、pull request、手動実行時に型検査とWeb版・Chrome拡張のビルドを行います。生成したZIPは`konjac-packages`アーティファクトから取得できます。

`master`へのpushまたは`master`上での手動実行では、Web版をGitHub Pagesへ配置します。GitHubの「Settings」→「Pages」→「Source」は「GitHub Actions」に設定してください。

`v`から始まるタグをpushすると、配布用ZIPを添付したGitHub Releaseを作成します。

## 開発

- `src/core`: 共通の抽出・表示ロジック
- `src/web`: Web版
- `src/extension`: Chrome拡張
- `src/cli`: CLI
- `work`: 検証用PDFと変換結果

抽出ロジックの検証手順やデバッグ方法は[AGENTS.md](AGENTS.md)を参照してください。
