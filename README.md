# Konjac

Konjacは、論文PDFを解析し、読みやすいプレーンなHTMLへ再構成するツールです。PDFの文字とレイアウトからタイトル、見出し、段落、図表、キャプション、参照リンクなどを推定し、図表を含む文書として表示します。

インストール不要のWeb版、閲覧中のPDFを開けるChrome拡張、HTML・JSONを生成できるCLIがあり、すべて同じ抽出エンジンを共有しています。デスクトップ版のGoogle Chrome 138以降、またはMicrosoft Edge 148以降では、組み込みのマシンローカルな翻訳による日本語表示と原文の併記も利用できます。表示結果は図表を埋め込んだ単一HTMLとして保存できます。

## クイックスタート

**[Konjac Webを開く](https://shioyadan.github.io/konjac/)**

1. ページへローカルPDFをドラッグ＆ドロップするか、「Choose a PDF」から選択します。
    - PDFはブラウザ内で処理され、サーバーへアップロードされません。
    - 対応するChrome・Edgeで「Choose a PDF」から読み込んだファイルは、「Recent files」に最大10件表示され、直接開き直せます。
2. デスクトップ版のGoogle Chrome 138以降、またはMicrosoft Edge 148以降では、「Translate to Japanese」で文書を日本語へ翻訳できます。
    - 翻訳はブラウザの組み込み機能によってマシン上で実行されます。
    - 初回は翻訳用の言語パックをダウンロードすることがあります。
3. 各段落や図表の「PDF」から、元のPDFの該当箇所を表示できます。
    - 複数ブロックを選択した場合は、選択位置に現れる「PDF selection」で該当範囲をまとめて表示します。
    - PDF上の枠はドラッグと右下のハンドルで調整でき、「Show image」で選択したHTMLや図表画像を元PDFの画像へ切り替えられます。
    - 本文は「Show HTML」、図表は「Restore image」で元の表示へ戻せます。
    - PDF表示はドラッグで移動、`Ctrl+wheel`で拡大縮小、右下のハンドルで高さを変更できます。
4. 翻訳後は、文書全体または段落ごとに原文を併記できます。「Export HTML」を押すと、その時点の翻訳・原文表示と図表を含む文書を、単独で開けるHTMLファイルとして保存できます。

## Web版として使う

- **起動**
    - GitHub Pagesへデプロイされた[Web版](https://shioyadan.github.io/konjac/)を直接利用できます。通常はこちらを使用してください。
    - ローカルで使用する場合は、ビルドで生成された`dist/web/index.html`をブラウザで直接開きます。
    - JavaScript、PDF.js Worker、CMapは単一HTMLに埋め込まれているため、別のファイルやHTTPサーバーは不要です。
- **PDFの読み込み**
    - ローカルPDFをドラッグ＆ドロップするか、「Choose a PDF」で選択します。
- **ファイル履歴**
    - File System Access APIに対応するChrome・Edgeでは、「Choose a PDF」で得たファイル名とファイルハンドルをIndexedDBへ保存し、「Recent files」から直接開き直せます。
    - 権限が失効した場合は、ブラウザが再許可を求めることがあります。
    - PDF本体は保存されません。ドラッグ＆ドロップまたは非対応ブラウザで開いたファイルは、履歴へ保存されません。
- **注意事項**
    - WSL上のHTMLを`file://wsl.localhost/...`として開く構成では、保存済みファイルハンドルへのアクセスが完了しないため、「Recent files」は無効になります。
    - GitHub Pages版、localhostで配信したページ、または`Z:\work\konjac\dist\web\index.html`のようなWindows側のパスから開いてください。
    - 通常のPDF選択と表示は、WSLの`file:` URLでも利用できます。

## Chrome拡張として使う

- **セットアップ**
    1. Chromeで`chrome://extensions`を開きます。
    2. 「デベロッパー モード」を有効にします。
    3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリの`dist/extension`ディレクトリを選びます。
- **PDFの読み込み**
    - PDF上で右クリックし、「View PDF」を選びます。
    - ローカルPDFを開く場合は、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可」を有効にします。
- **ファイル履歴**
    - 読み込みに成功したPDFは「Recent files」に最大10件保存され、ファイル名を押すと再度開けます。
    - 履歴はブラウザ内にだけ保存され、PDF本体は複製されません。
- **元PDFの表示**
    - 各段落や図表の「PDF」から、元のPDFの該当箇所を表示できます。
    - 複数ブロックを選択した場合は、選択位置に現れる「PDF selection」で該当範囲をページごとにまとめて表示します。
    - PDF上の枠はドラッグと右下のハンドルで調整でき、「Show image」で選択したHTMLや図表画像を元PDFの画像へ切り替えられます。
    - 本文は「Show HTML」、図表は「Restore image」で元の表示へ戻せます。
    - PDF表示はドラッグで移動、`Ctrl+wheel`で拡大縮小、右下のハンドルで高さを変更できます。
- **翻訳**
    - デスクトップ版のGoogle Chrome 138以降、またはMicrosoft Edge 148以降では、「Translate to Japanese」で文書を日本語へ翻訳できます。
    - 翻訳後は、文書全体または段落ごとに原文を併記できます。
    - 初回は翻訳用の言語パックをダウンロードすることがあります。
- **エクスポート**
    - 「Export HTML」を押すと、表示結果を単一HTMLとして保存できます。

## CLIとして使う

- **HTMLへの変換**

    ```sh
    make cli PDF="work/input.pdf" OUT="work/output.html"
    ```

- **JSONへの出力**

    ```sh
    make cli-json PDF="work/input.pdf" JSON_OUT="work/output.json"
    ```

- **実行ファイル**
    - CLI本体は`dist/cli/cli.cjs`に生成されます。

## ビルド

- **必要な環境**
    - Node.jsとnpmが必要です。
- **全体のビルド**

    ```sh
    npm install
    make
    ```

- **生成物**
    - `dist/extension`: Chrome拡張
    - `dist/web/index.html`: 単一HTMLのWeb版
    - `dist/cli`: CLI
- **個別のビルド**
    - `make extension-build`、`make web-build`、`make cli-build`を使用します。
- **配布用ZIPの生成**

    ```sh
    make package
    ```

    - `dist/packages/konjac-web.zip`と`dist/packages/konjac-extension.zip`が生成されます。
- **ソースコードの構成**
    - `src/core`: 共通の抽出・表示ロジック
    - `src/extension`: Chrome拡張
    - `src/cli`: CLI
    - `src/web`: 単一HTMLのWeb版

## CIと配布

- **継続的インテグレーション**
    - GitHub Actionsは、push、pull request、手動実行時に型検査とWeb版・Chrome拡張のビルドを行います。
    - 生成された2つのZIPは、各ワークフロー実行の`konjac-packages`アーティファクトから取得できます。
- **Web版のデプロイ**
    - `master`へのpushまたは`master`上での手動実行では、`dist/web/index.html`をGitHub Pagesへ配置します。
    - GitHubでは、リポジトリの「Settings」→「Pages」→「Source」を「GitHub Actions」に設定してください。
- **リリース**
    - `v`から始まるタグをpushすると、同じZIPを添付したGitHub Releaseを作成します。
- **開発・デバッグ**
    - 詳細は[AGENTS.md](AGENTS.md)を参照してください。
