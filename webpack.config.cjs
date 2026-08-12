// __dirname 等を使うために，.cjs になっている

module.exports = {
    // 入力ファイル
    entry: {
        viewer: "./src/extension/viewer.ts",
        main: "./src/extension/main.ts"
    },
    output: {
        // 出力先
        path: `${__dirname}/dist/extension`,
        // 生成済みファイルから参照される時のパス
        publicPath: "auto",
        // 生成ファイル
        filename: "[name].js",
        clean: true,
        // 出力フォーマット
        // library: "external_modules",
        // libraryTarget: "umd",
    },

    // ブラウザ 向け
    target: "web",

    module: {
        rules: [
            {   // Typescript
                test: /\.ts$/,
                use: "ts-loader"
            }
        ]
    },

    resolve: {
        extensions: [".ts", ".js"]
    },

    // 開発バージョン
    //mode: "production",
    mode: "development",

    // Source map の有効化
    devtool: 'inline-source-map'
};
