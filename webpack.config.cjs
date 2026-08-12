// Chrome拡張向けのバンドル設定

module.exports = (_env, argv) => {
    const isProduction = argv.mode === "production";

    return {
        entry: {
            viewer: "./src/extension/viewer.ts",
            main: "./src/extension/main.ts"
        },
        output: {
            path: `${__dirname}/dist/extension`,
            publicPath: "auto",
            filename: "[name].js",
            clean: true
        },
        target: "web",
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
        mode: isProduction ? "production" : "development",
        devtool: isProduction ? false : "inline-source-map"
    };
};
