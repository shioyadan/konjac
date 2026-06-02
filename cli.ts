"use strict";

import * as pdfjsLib from "pdfjs-dist/build/pdf.js";
import {PDF_Node, extractNodesFromTextItems, nodesToHTML} from "./extractor";

declare const process: {
    argv: string[];
    exitCode: number | undefined;
};

type OutputMode = "html" | "json";

function usage() {
    console.error("usage: node dist/cli.cjs [--html|--json] <pdf-file>");
}

function parseArgs(args: string[]) {
    let mode: OutputMode = "html";
    let fileName = "";

    for (let arg of args) {
        if (arg == "--html") {
            mode = "html";
        }
        else if (arg == "--json") {
            mode = "json";
        }
        else if (arg == "-h" || arg == "--help") {
            usage();
            return null;
        }
        else if (!fileName) {
            fileName = arg;
        }
        else {
            usage();
            return null;
        }
    }

    if (!fileName) {
        usage();
        return null;
    }

    return {mode, fileName};
}

async function extractPDFFile(fileName: string) {
    let loadingTask = pdfjsLib.getDocument({
        url: fileName,
        cMapPacked: true,
        cMapUrl: "node_modules/pdfjs-dist/cmaps/",
        verbosity: 0
    });

    let pdf = await loadingTask.promise;
    let nodes: PDF_Node[] = [];

    for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
        let page = await pdf.getPage(pageNumber);
        let textContent = await page.getTextContent();
        nodes.push(...extractNodesFromTextItems(textContent.items));
    }

    return nodes;
}

async function main() {
    let options = parseArgs(process.argv.slice(2));
    if (!options) {
        process.exitCode = 1;
        return;
    }

    let nodes = await extractPDFFile(options.fileName);
    if (options.mode == "json") {
        console.log(JSON.stringify(nodes, null, 2));
    }
    else {
        console.log(nodesToHTML(nodes));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
