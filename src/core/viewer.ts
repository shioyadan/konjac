"use strict";
import "./browser_dependencies";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
    PDF_Node,
    PDF_NodeType,
    PDF_PageInput,
    PDF_Rect,
    buildHTMLLinkContext,
    extractNodesFromPages,
    extractPageInputFromPDFPage,
    figureImageDisplayWidth,
    linkedNodeHTML,
    nodeHTMLId,
    nodeToHTMLElementName
} from "./extractor";

console.log("initialized.");

const FIGURE_RENDER_SCALE = 4.0;

interface ChromeTranslator {
    translate(text: string): Promise<string>;
    destroy?(): void;
}

interface ChromeTranslatorFactory {
    availability(options: {sourceLanguage: string; targetLanguage: string}): Promise<string>;
    create(options: {
        sourceLanguage: string;
        targetLanguage: string;
        monitor(monitor: EventTarget): void;
    }): Promise<ChromeTranslator>;
}

interface PDFLoadOptions {
    CMapReaderFactory?: new (options: {baseUrl?: string | null; isCompressed?: boolean}) => unknown;
}

declare global {
    interface Window {
        Translator?: ChromeTranslatorFactory;
    }
}

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
    let linkContext = buildHTMLLinkContext(nodes);

    for (let node of nodes) {
        let id = nodeHTMLId(node, linkContext);
        if (node.type == PDF_NodeType.FIGURE) {
            let figure = document.createElement("figure");
            if (id) {
                figure.id = id;
            }
            figure.style.margin = "1.5rem 0";
            if (node.imageSrc) {
                let image = document.createElement("img");
                image.src = node.imageSrc;
                image.alt = node.str;
                image.style.display = "block";
                image.style.width = figureImageDisplayWidth(node.rect);
                image.style.maxWidth = "100%";
                image.style.height = "auto";
                image.style.margin = "0 auto 0.5rem";
                figure.appendChild(image);
            }

            let caption = document.createElement("figcaption");
            caption.innerHTML = linkedNodeHTML(node, linkContext);
            caption.style.textAlign = "left";
            figure.appendChild(caption);
            main.appendChild(figure);
            continue;
        }

        let div = document.createElement(nodeToHTMLElementName(node));
        if (id) {
            div.id = id;
        }
        div.innerHTML = linkedNodeHTML(node, linkContext);
        main.appendChild(div);
    }

}

function htmlFileName(pdfURL: string) {
    let path = pdfURL;
    try {
        path = new URL(pdfURL).pathname;
    }
    catch {
        // URL でない場合は入力をパスとして扱う。
    }

    let name = path.split(/[\\/]/).pop() || "document";
    try {
        name = decodeURIComponent(name);
    }
    catch {
        // 不正な percent encoding はそのままファイル名に使う。
    }
    return `${name.replace(/\.pdf$/i, "") || "document"}.html`;
}

function exportedTranslationContent(exported: HTMLElement) {
    for (let element of exported.querySelectorAll<HTMLElement>(".translatable")) {
        let original = element.querySelector<HTMLElement>(":scope > .translation-original");
        let translated = element.querySelector<HTMLElement>(":scope > .translation-japanese");
        let content = translated
            ? Array.from(translated.childNodes).map((node) => node.cloneNode(true))
            : [];
        if (original && !original.hidden) {
            let originalCopy = original.cloneNode(true) as HTMLElement;
            originalCopy.className = "translation-alternative";
            content.push(originalCopy);
        }
        element.replaceChildren(...content);
        element.classList.remove("translatable");
    }
}

function exportHTML(pdfURL: string) {
    let exported = document.documentElement.cloneNode(true) as HTMLElement;
    exportedTranslationContent(exported);
    exported.querySelectorAll("script, [data-export-exclude]").forEach((element) => element.remove());

    let fileName = htmlFileName(pdfURL);
    let title = exported.querySelector("title");
    if (title) {
        title.textContent = fileName.replace(/\.html$/i, "");
    }

    let blobURL = URL.createObjectURL(new Blob(
        ["<!DOCTYPE html>\n", exported.outerHTML],
        {type: "text/html;charset=utf-8"}
    ));
    let link = document.createElement("a");
    link.href = blobURL;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobURL));
}

function enableHTMLExport(pdfURL: string) {
    let controls = document.getElementById("document-controls");
    let button = document.getElementById("export-html");
    if (controls && button instanceof HTMLButtonElement) {
        controls.hidden = false;
        button.onclick = () => exportHTML(pdfURL);
    }
}

function translatableElements() {
    return Array.from(document.querySelectorAll<HTMLElement>(
        "#main > p, #main > h1, #main > h2, #main > h3, #main > h4, #main > h5, #main > h6, #main > figcaption, #main > figure > figcaption"
    )).filter((element) => (element.textContent?.trim().length ?? 0) > 0);
}

function setElementOriginalVisible(element: HTMLElement, visible: boolean) {
    let original = element.querySelector<HTMLElement>(":scope > .translation-original");
    let toggle = element.querySelector<HTMLButtonElement>(":scope > .translation-toggle");
    if (!original || !toggle) {
        return;
    }

    original.hidden = !visible;
    original.classList.toggle("translation-alternative", visible);
    toggle.textContent = visible ? "Hide original" : "Original";
    toggle.setAttribute("aria-label", visible ? "Hide original text" : "Show original text");
    toggle.setAttribute("aria-expanded", String(visible));
}

function attachTranslation(element: HTMLElement, translatedText: string) {
    let original = document.createElement("span");
    original.className = "translation-original";
    original.lang = "en";
    while (element.firstChild) {
        original.appendChild(element.firstChild);
    }

    let translated = document.createElement("span");
    translated.className = "translation-japanese";
    translated.lang = "ja";
    translated.textContent = translatedText;

    let toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "text-button translation-toggle";
    toggle.onclick = () => setElementOriginalVisible(element, original.hasAttribute("hidden"));

    element.classList.add("translatable");
    element.lang = "ja";
    element.append(translated, toggle, original);
    setElementOriginalVisible(element, false);
}

function setDocumentOriginalsVisible(visible: boolean) {
    for (let element of document.querySelectorAll<HTMLElement>("#main .translatable")) {
        setElementOriginalVisible(element, visible);
    }

    let toggle = document.getElementById("toggle-document-originals");
    if (toggle instanceof HTMLButtonElement) {
        toggle.textContent = visible ? "Hide originals" : "Show originals";
        toggle.onclick = () => setDocumentOriginalsVisible(!visible);
    }
}

async function translateDocument() {
    let factory = window.Translator;
    let translateButton = document.getElementById("translate-document");
    let originalsButton = document.getElementById("toggle-document-originals");
    let status = document.getElementById("translation-status");
    let progress = document.getElementById("progress") as HTMLProgressElement | null;
    if (!factory || !(translateButton instanceof HTMLButtonElement) || !(originalsButton instanceof HTMLButtonElement)) {
        return;
    }

    translateButton.disabled = true;
    if (status) {
        status.textContent = "Preparing translation…";
    }
    if (progress) {
        progress.hidden = false;
        progress.removeAttribute("value");
    }

    try {
        // create() は言語パックのダウンロード時にユーザー操作を要求するため、
        // Translate ボタンの click handler から直接呼び出す。
        let translator = await factory.create({
            sourceLanguage: "en",
            targetLanguage: "ja",
            monitor(monitor) {
                monitor.addEventListener("downloadprogress", (event) => {
                    let loaded = (event as ProgressEvent).loaded;
                    if (progress) {
                        progress.max = 1;
                        progress.value = loaded;
                    }
                });
            }
        });

        let elements = translatableElements();
        if (progress) {
            progress.max = elements.length;
            progress.value = 0;
        }
        for (let [index, element] of elements.entries()) {
            let sourceText = element.textContent?.trim() ?? "";
            try {
                attachTranslation(element, await translator.translate(sourceText));
            }
            catch (error) {
                console.warn("Failed to translate a block", error);
            }
            if (progress) {
                progress.value = index + 1;
            }
            if (status) {
                status.textContent = `Translating ${index + 1}/${elements.length}`;
            }
        }
        translator.destroy?.();

        translateButton.hidden = true;
        originalsButton.hidden = false;
        setDocumentOriginalsVisible(false);
        if (status) {
            status.textContent = "";
        }
    }
    catch (error) {
        console.warn("Translation is unavailable", error);
        translateButton.disabled = false;
        if (status) {
            status.textContent = "Translation unavailable";
        }
    }
    finally {
        if (progress) {
            progress.hidden = true;
        }
    }
}

async function enableTranslation() {
    let factory = window.Translator;
    let controls = document.getElementById("document-controls");
    let translationControls = document.getElementById("translation-controls");
    let button = document.getElementById("translate-document");
    if (!factory || !controls || !translationControls || !(button instanceof HTMLButtonElement)) {
        return;
    }

    try {
        if (await factory.availability({sourceLanguage: "en", targetLanguage: "ja"}) == "unavailable") {
            return;
        }
        controls.hidden = false;
        translationControls.hidden = false;
        button.onclick = () => void translateDocument();
    }
    catch (error) {
        console.warn("Failed to check translation availability", error);
    }
}

export function loadPDF(source: string, sourceName = source, options: PDFLoadOptions = {}) {
    let progress = document.getElementById("progress") as HTMLProgressElement | null;
    let main = document.getElementById("main");
    let controls = document.getElementById("document-controls");
    let translationControls = document.getElementById("translation-controls");
    let translateButton = document.getElementById("translate-document");
    let originalsButton = document.getElementById("toggle-document-originals");
    let translationStatus = document.getElementById("translation-status");
    main?.replaceChildren();
    if (controls) {
        controls.hidden = true;
    }
    if (translationControls) {
        translationControls.hidden = true;
    }
    if (translateButton instanceof HTMLButtonElement) {
        translateButton.hidden = false;
        translateButton.disabled = false;
    }
    if (originalsButton instanceof HTMLButtonElement) {
        originalsButton.hidden = true;
    }
    if (translationStatus) {
        translationStatus.textContent = "";
    }
    if (progress) {
        progress.hidden = false;
        progress.removeAttribute("value");
    }
    let loadingTask = pdfjsLib.getDocument({
        url: source,
        cMapPacked: true,
        ...(options.CMapReaderFactory
            ? {CMapReaderFactory: options.CMapReaderFactory, useWorkerFetch: false}
            : {cMapUrl: "cmaps/"})
    });

    loadingTask.onProgress = ({loaded, total}: {loaded: number; total: number}) => {
        if (progress && total > 0) {
            progress.max = total;
            progress.value = loaded;
        }
    };

    return loadingTask.promise.then(async (pdf) => {
        if (progress) {
            progress.max = pdf.numPages;
            progress.value = 0;
        }
        let pages: PDF_PageInput[] = [];
        let pageProxies: any[] = [];
        for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
            let page = await pdf.getPage(pageNumber);
            pages.push(await extractPageInputFromPDFPage(page, pageNumber, pdfjsLib.OPS as unknown as Record<string, number>));
            pageProxies.push(page);
            if (progress) {
                progress.value = pageNumber;
            }
        }
        let nodes = extractNodesFromPages(pages);
        await attachFigureImages(nodes, pageProxies);
        show(nodes);
        if (progress) {
            progress.hidden = true;
        }
        enableHTMLExport(sourceName);
        void enableTranslation();
    });
}

