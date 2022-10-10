// __dirname 等を使うために，.cjs になっている

module.exports = {
    // 入力ファイル
    entry: {
        viewer: "./viewer.ts",
        main: "./main.ts"
    },
    output: {
        // 出力先
        path: `${__dirname}/dist`,
        // 生成済みファイルから参照される時のパス
        publicPath: "dist/",
        // 生成ファイル
        filename: "[name].js",
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
            },
            {   // CSS
                test: /\.css$/,
                use: [
                    "style-loader",
                    {
                        loader: "css-loader",
                        options: { url: false }
                    }
                ]
            }
        ]
    },

    // 開発バージョン
    //mode: "production",
    mode: "development",

    // Source map の有効化
    devtool: 'inline-source-map',
};
