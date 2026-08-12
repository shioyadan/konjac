// Node.js CLI 向けのバンドル設定

module.exports = {
    entry: {
        cli: "./cli.ts"
    },
    output: {
        path: `${__dirname}/dist/cli`,
        filename: "cli.cjs",
        clean: true
    },
    target: "node",
    externals: {
        canvas: "commonjs canvas"
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
