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
            {
                // 拡張子 .ts の場合
                test: /\.ts$/,
                // TypeScript をコンパイルする
                use: "ts-loader"
            },
            {
                test: /\.css/,
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

    // CSS
    // module: {
    //     rules: [{
    //         test: /\.css/,
    //         use: [
    //             "style-loader",
    //             {
    //                 loader: "css-loader",
    //                 options: { url: false }
    //             }
    //         ]
    //     }]
    // }
};
