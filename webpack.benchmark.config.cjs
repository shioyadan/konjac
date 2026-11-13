const path = require('node:path');
module.exports = {
    entry: './src/benchmark/browser.ts',
    output: {path: path.resolve(__dirname, 'dist/benchmark'), filename: 'benchmark.js', publicPath: '', clean: true},
    target: 'web', mode: 'production', devtool: false,
    module: {rules: [
        {test: /\.ts$/, use: 'ts-loader'},
        {test: /\.wasm$/, type: 'asset/resource', generator: {filename: 'wllama.wasm'}}
    ]},
    resolve: {extensions: ['.ts', '.js']}
};
