"use strict";
import "./external_modules_src";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {PDF_Node, PDF_NodeType, PDF_PageInput, PDF_Rect, extractNodesFromPages, nodeToHTMLElementName} from "./extractor";

pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), {type: "module"});

console.log("initialized.");

const FIGURE_RENDER_SCALE = 4.0;

interface RenderedPageCanvas {
    canvas: HTMLCanvasElement;
    pageHeight: number;
}

async function renderPageCanvas(page: any) {
    let viewport = page.getViewport({scale: FIGURE_RENDER_SCALE});
    let canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    let context = canvas.getContext("2d");
    if (!context) {
        return null;
    }

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

    let crop = document.createElement("canvas");
    crop.width = sourceWidth;
    crop.height = sourceHeight;

    let cropContext = crop.getContext("2d");
    if (!cropContext) {
        return "";
    }

    cropContext.fillStyle = "white";
    cropContext.fillRect(0, 0, sourceWidth, sourceHeight);
    cropContext.drawImage(
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
    let pageCanvasPromises = new Map<number, Promise<RenderedPageCanvas | null>>();

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

function show(nodes: PDF_Node[]) {
    let main = document.getElementById("main");
    if (!main) {
        return;
    }

    main.replaceChildren();

    for (let node of nodes) {
        if (node.type == PDF_NodeType.FIGURE) {
            let figure = document.createElement("figure");
            if (node.imageSrc) {
                let image = document.createElement("img");
                image.src = node.imageSrc;
                image.alt = node.str;
                image.style.display = "block";
                image.style.maxWidth = "88%";
                image.style.height = "auto";
                image.style.margin = "0 auto 0.5rem";
                figure.appendChild(image);
            }

            let caption = document.createElement("figcaption");
            caption.appendChild(document.createTextNode(node.str));
            caption.style.textAlign = "center";
            figure.appendChild(caption);
            main.appendChild(figure);
            continue;
        }

        let text = document.createTextNode(node.str);
        let div = document.createElement(nodeToHTMLElementName(node));
        div.appendChild(text);
        main.appendChild(div);
    }

}

function load(fileName: string) {
    let loadingTask = pdfjsLib.getDocument({
        url: fileName,
        cMapPacked: true,
        cMapUrl: "cmaps/"   // 日本語（や他の言語）を表示するために必要なマップファイル．Makefile で dist にコピーされる
    });

    loadingTask.promise.then(async (pdf) => {
        let pages: PDF_PageInput[] = [];
        let pageProxies: any[] = [];
        for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
            let page = await pdf.getPage(pageNumber);
            let viewport = page.getViewport({scale: 1});
            let textContent = await page.getTextContent();
            pages.push({
                items: textContent.items,
                width: viewport.width,
                height: viewport.height
            });
            pageProxies.push(page);
        }
        let nodes = extractNodesFromPages(pages);
        await attachFigureImages(nodes, pageProxies);
        show(nodes);
    });
}


// アクティブなタブの URL を取得して使う
chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    let url = tabs[0].url;
    // file= にローカルにダウンロードした PDF の URL が埋め込まれているので，それをロードする
    if (url && url.match(/\?file=(.+)$/)) {
        let targetURL = decodeURIComponent(RegExp.$1);
        console.log(targetURL);
        load(targetURL);        
    }
});



// console.log(import.meta.url);

