module.exports = {
    // 入力ファイル
    entry: "./external_modules_src.js",
    output: {
        // 出力先
        path: `${__dirname}/dist`,
        // 生成済みファイルから参照される時のパス
        publicPath: "dist/",
        // 生成ファイル
        filename: "external_modules.js",
        // 出力フォーマット
        library: "external_modules",
        libraryTarget: "umd",
    },
    // electron 向け
    target: "web",
    
    // 開発バージョン
    //mode: "production",
    mode: "development",

    // Source map の有効化
    devtool: 'inline-source-map',

    // CSS
    module: {
        rules: [{
            test: /\.css/,
            use: [
                "style-loader",
                {
                    loader: "css-loader",
                    options: { url: false }
                }
            ]
        }]
    }
};
