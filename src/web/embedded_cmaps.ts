"use strict";

interface WebpackContext {
    keys(): string[];
    (id: string): string | {default: string};
}

declare const require: {
    context(directory: string, useSubdirectories: boolean, pattern: RegExp): WebpackContext;
};

// file://でも読めるよう、PDF.jsのCMapをWeb bundleへ埋め込む。
const context = require.context("pdfjs-dist/cmaps", false, /\.bcmap$/);
const cMaps = new Map(context.keys().map((key) => {
    let module = context(key);
    let dataURL = typeof module == "string" ? module : module.default;
    return [key.replace(/^\.\//, "").replace(/\.bcmap$/, ""), dataURL];
}));

function dataURLBytes(dataURL: string) {
    let base64 = dataURL.slice(dataURL.indexOf(",") + 1);
    let binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class EmbeddedCMapReaderFactory {
    async fetch({name}: {name: string}) {
        let dataURL = cMaps.get(name);
        if (!dataURL) {
            throw new Error(`Unknown CMap: ${name}`);
        }
        return {
            cMapData: dataURLBytes(dataURL),
            isCompressed: true
        };
    }
}
