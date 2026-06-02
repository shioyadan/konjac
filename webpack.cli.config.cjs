// Node.js CLI 向けのバンドル設定

module.exports = {
    entry: {
        cli: "./cli.ts"
    },
    output: {
        path: `${__dirname}/dist`,
        filename: "cli.cjs"
    },
    target: "node",
    externals: {
        "pdfjs-dist/build/pdf.js": "commonjs pdfjs-dist/build/pdf.js"
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: "ts-loader"
            }
        ]
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    mode: "development",
    devtool: "inline-source-map"
};
