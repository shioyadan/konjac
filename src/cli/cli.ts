"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
    PDF_DebugMaskDump,
    PDF_Node,
    PDF_NodeType,
    PDF_PageInput,
    PDF_Rect,
    extractNodesFromPages,
    extractPageInputFromPDFPage,
    nodesToHTML
} from "../core/extractor";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.mjs";

declare function require(moduleName: string): unknown;

declare const process: {
    argv: string[];
    exitCode: number | undefined;
};

type OutputMode = "html" | "json";

interface NodeCanvasLike {
    width: number;
    height: number;
    getContext(contextId: "2d"): CanvasRenderingContext2D;
    toDataURL(type?: string): string;
}

interface RenderedPageCanvas {
    canvas: NodeCanvasLike;
    pageHeight: number;
}

const {createCanvas} = require("canvas") as {
    createCanvas: (width: number, height: number) => NodeCanvasLike;
};
const fs = require("fs") as {
    mkdirSync: (path: string, options?: {recursive?: boolean}) => void;
    writeFileSync: (path: string, data: string) => void;
};
const FIGURE_RENDER_SCALE = 4.0;

function usage() {
    console.error("usage: node dist/cli/cli.cjs [--html|--json] [--debug-mask <dir>] [--debug-scan <caption-text>] <pdf-file>");
}

function parseArgs(args: string[]) {
    let mode: OutputMode = "html";
    let debugMaskDir = "";
    let debugScanCaption = "";
    let fileName = "";

    for (let i = 0; i < args.length; i++) {
        let arg = args[i];
        if (arg == "--html") {
            mode = "html";
        }
        else if (arg == "--json") {
            mode = "json";
        }
        else if (arg == "--debug-mask") {
            debugMaskDir = args[++i] ?? "";
            if (!debugMaskDir) {
                usage();
                return null;
            }
        }
        else if (arg.startsWith("--debug-mask=")) {
            debugMaskDir = arg.slice("--debug-mask=".length);
            if (!debugMaskDir) {
                usage();
                return null;
            }
        }
        else if (arg == "--debug-scan") {
            debugScanCaption = args[++i] ?? "";
            if (!debugScanCaption) {
                usage();
                return null;
            }
        }
        else if (arg.startsWith("--debug-scan=")) {
            debugScanCaption = arg.slice("--debug-scan=".length);
            if (!debugScanCaption) {
                usage();
                return null;
            }
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

    return {mode, fileName, debugMaskDir, debugScanCaption};
}

async function renderPageCanvas(page: any) {
    let viewport = page.getViewport({scale: FIGURE_RENDER_SCALE});
    let canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    let context = canvas.getContext("2d");

    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({canvasContext: context, viewport}).promise;

    return {
        canvas,
        pageHeight: page.getViewport({scale: 1}).height
    };
}

function cropRectFromPage(renderedPage: RenderedPageCanvas, rect: PDF_Rect) {
    let scale = FIGURE_RENDER_SCALE;
    let sourceX = Math.max(0, Math.floor(rect.x * scale));
    let sourceY = Math.max(0, Math.floor((renderedPage.pageHeight - rect.y - rect.height) * scale));
    let sourceWidth = Math.min(renderedPage.canvas.width - sourceX, Math.ceil(rect.width * scale));
    let sourceHeight = Math.min(renderedPage.canvas.height - sourceY, Math.ceil(rect.height * scale));

    if (sourceWidth <= 0 || sourceHeight <= 0) {
        return "";
    }

    let crop = createCanvas(sourceWidth, sourceHeight);
    let cropContext = crop.getContext("2d");
    cropContext.fillStyle = "white";
    cropContext.fillRect(0, 0, sourceWidth, sourceHeight);
    (cropContext as any).drawImage(
        renderedPage.canvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
    );
    return crop.toDataURL("image/png");
}

async function attachFigureImages(nodes: PDF_Node[], pageProxies: any[]) {
    let pageCanvasPromises = new Map<number, Promise<RenderedPageCanvas>>();

    for (let node of nodes) {
        if (node.type != PDF_NodeType.FIGURE || !node.rect) {
            continue;
        }

        if (!pageCanvasPromises.has(node.rect.page)) {
            let page = pageProxies[node.rect.page - 1];
            if (!page) {
                continue;
            }
            pageCanvasPromises.set(node.rect.page, renderPageCanvas(page));
        }

        let renderedPage = await pageCanvasPromises.get(node.rect.page);
        if (renderedPage) {
            node.imageSrc = cropRectFromPage(renderedPage, node.rect);
        }
    }
}

function writeDebugMaskDump(dir: string, dump: PDF_DebugMaskDump) {
    let base = dir.replace(/[\/\\]+$/, "");
    fs.mkdirSync(base, {recursive: true});
    fs.writeFileSync(`${base}/page-${String(dump.page).padStart(3, "0")}-mask.svg`, dump.svg);
}

async function extractPDFFile(fileName: string, renderImages: boolean, debugMaskDir?: string, debugScanCaption?: string) {
    let loadingTask = pdfjsLib.getDocument({
        url: fileName,
        cMapPacked: true,
        cMapUrl: "node_modules/pdfjs-dist/cmaps/",
        verbosity: 0
    });

    let pdf = await loadingTask.promise;
    let pages: PDF_PageInput[] = [];
    let pageProxies: any[] = [];

    for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
        let page = await pdf.getPage(pageNumber);
        pages.push(await extractPageInputFromPDFPage(page, pageNumber, pdfjsLib.OPS as unknown as Record<string, number>));
        pageProxies.push(page);
    }

    let extractOptions = {
        ...(debugMaskDir ? {debugMaskSink: (dump: PDF_DebugMaskDump) => writeDebugMaskDump(debugMaskDir, dump)} : {}),
        ...(debugScanCaption ? {debugScanCaption, debugScanSink: (message: string) => console.error(message)} : {})
    };
    let nodes = extractNodesFromPages(pages, debugMaskDir || debugScanCaption ? extractOptions : undefined);
    if (renderImages) {
        await attachFigureImages(nodes, pageProxies);
    }
    return nodes;
}

async function main() {
    let options = parseArgs(process.argv.slice(2));
    if (!options) {
        process.exitCode = 1;
        return;
    }

    let nodes = await extractPDFFile(options.fileName, options.mode == "html", options.debugMaskDir, options.debugScanCaption);
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
