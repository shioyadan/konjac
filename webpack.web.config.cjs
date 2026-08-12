// 通常の Web ページ向けのバンドル設定

const path = require("node:path");
const HtmlInlineScriptPlugin = require("html-inline-script-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = (_env, argv) => {
    const isProduction = argv.mode === "production";

    return {
        entry: {
            web_viewer: "./src/web/viewer.ts"
        },
        output: {
            path: path.resolve(__dirname, "dist/web"),
            publicPath: "",
            filename: "web_viewer.js",
            clean: true
        },
        target: "web",
        mode: isProduction ? "production" : "development",
        devtool: isProduction ? false : "inline-source-map",
        optimization: {
            minimizer: [new TerserPlugin({extractComments: false})]
        },
        module: {
            rules: [
                {
                    test: /pdf\.worker\.mjs$/,
                    use: {
                        loader: "worker-loader",
                        options: {
                            inline: "no-fallback"
                        }
                    }
                },
                {
                    test: /\.ts$/,
                    use: "ts-loader"
                },
                {
                    test: /\.bcmap$/i,
                    type: "asset/inline",
                    generator: {
                        dataUrl: {
                            mimetype: "application/octet-stream",
                            encoding: "base64"
                        }
                    }
                }
            ]
        },
        resolve: {
            extensions: [".ts", ".js"]
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: "./src/web/index.html",
                filename: "index.html",
                inject: "body",
                scriptLoading: "defer",
                minify: isProduction
            }),
            ...(isProduction ? [new HtmlInlineScriptPlugin()] : [])
        ]
    };
};
