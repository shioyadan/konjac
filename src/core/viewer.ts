"use strict";

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
const SOURCE_PREVIEW_RENDER_SCALE = 2.0;

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
    scale: number;
}

interface PDFSourceLocation {
    page: any;
    rect: PDF_Rect;
}

interface PDFSourcePageImage {
    src: string;
    width: number;
    height: number;
    pageHeight: number;
    scale: number;
}

const pdfSourceLocations = new WeakMap<HTMLElement, PDFSourceLocation>();
const pdfSourcePageImages = new WeakMap<object, Promise<PDFSourcePageImage | null>>();
let pdfSelectionButton: HTMLButtonElement | null = null;
let selectedPDFSources: PDFSourceLocation[] = [];
let selectedPDFElements: HTMLElement[] = [];
let selectedPDFAnchor: HTMLElement | null = null;
let selectedPDFRange: Range | null = null;

async function renderPageCanvas(page: any, scale = FIGURE_RENDER_SCALE) {
    let viewport = page.getViewport({scale});
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
        pageHeight: page.getViewport({scale: 1}).height,
        scale
    };
}

function cropRectFromPage(renderedPage: RenderedPageCanvas, rect: PDF_Rect) {
    let scale = renderedPage.scale;
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

function sourcePageImage(page: any) {
    let cached = pdfSourcePageImages.get(page);
    if (cached) {
        return cached;
    }

    let rendered = renderPageCanvas(page, SOURCE_PREVIEW_RENDER_SCALE).then((renderedPage) => renderedPage ? {
        src: renderedPage.canvas.toDataURL("image/png"),
        width: renderedPage.canvas.width,
        height: renderedPage.canvas.height,
        pageHeight: renderedPage.pageHeight,
        scale: renderedPage.scale
    } : null);
    pdfSourcePageImages.set(page, rendered);
    return rendered;
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

function rememberPDFSource(element: HTMLElement, node: PDF_Node, pageProxies: any[]) {
    // 図表は図表領域、それ以外は元テキスト領域を表示の中心にする。
    let rect = node.type == PDF_NodeType.FIGURE
        ? node.rect ?? node.sourceRect
        : node.sourceRect ?? node.rect;
    let page = rect ? pageProxies[rect.page - 1] : null;
    if (rect && page) {
        pdfSourceLocations.set(element, {page, rect});
    }
}

function show(nodes: PDF_Node[], pageProxies: any[]) {
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
            rememberPDFSource(caption, node, pageProxies);
            attachPDFSourceToggle(caption);
            figure.appendChild(caption);
            main.appendChild(figure);
            continue;
        }

        let div = document.createElement(nodeToHTMLElementName(node));
        if (id) {
            div.id = id;
        }
        div.innerHTML = linkedNodeHTML(node, linkContext);
        rememberPDFSource(div, node, pageProxies);
        attachPDFSourceToggle(div);
        main.appendChild(div);
    }
    enablePDFSelection();
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
    )).filter((element) => translatableText(element) != "");
}

function translatableText(element: HTMLElement) {
    let source = element.cloneNode(true) as HTMLElement;
    source.querySelectorAll("[data-export-exclude]").forEach((excluded) => excluded.remove());
    return source.textContent?.trim() ?? "";
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

function setPDFSourceVisible(toggle: HTMLButtonElement, preview: HTMLElement, visible: boolean, page: number) {
    preview.hidden = !visible;
    toggle.textContent = visible ? "Hide PDF" : "PDF";
    toggle.setAttribute("aria-label", visible ? `Hide source PDF page ${page}` : `Show source PDF page ${page}`);
    toggle.setAttribute("aria-expanded", String(visible));
}

function enableDragScrolling(viewport: HTMLElement) {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    viewport.onpointerdown = (event) => {
        let bounds = viewport.getBoundingClientRect();
        let contentRight = bounds.left + viewport.clientLeft + viewport.clientWidth;
        let contentBottom = bounds.top + viewport.clientTop + viewport.clientHeight;
        let onScrollbar = event.clientX >= contentRight || event.clientY >= contentBottom;
        let onResizeHandle = event.clientX >= bounds.right - 24 && event.clientY >= bounds.bottom - 24;
        if (event.button != 0 || onScrollbar || onResizeHandle) {
            return;
        }
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = viewport.scrollLeft;
        startTop = viewport.scrollTop;
        viewport.setPointerCapture(pointerId);
        viewport.classList.add("dragging");
        event.preventDefault();
    };
    viewport.onpointermove = (event) => {
        if (pointerId != event.pointerId) {
            return;
        }
        viewport.scrollLeft = startLeft - (event.clientX - startX);
        viewport.scrollTop = startTop - (event.clientY - startY);
    };
    let stopDragging = (event: PointerEvent) => {
        if (pointerId != event.pointerId) {
            return;
        }
        if (viewport.hasPointerCapture(pointerId)) {
            viewport.releasePointerCapture(pointerId);
        }
        pointerId = null;
        viewport.classList.remove("dragging");
    };
    viewport.onpointerup = stopDragging;
    viewport.onpointercancel = stopDragging;
}

function layoutPDFSourcePage(
    pageElement: HTMLElement,
    image: HTMLImageElement,
    highlight: HTMLElement,
    page: PDFSourcePageImage,
    rect: PDF_Rect,
    zoom: number
) {
    let scale = page.scale * zoom;
    let width = page.width * zoom;
    let height = page.height * zoom;
    pageElement.style.width = `${width}px`;
    pageElement.style.height = `${height}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    highlight.style.left = `${rect.x * scale}px`;
    highlight.style.top = `${(page.pageHeight - rect.y - rect.height) * scale}px`;
    highlight.style.width = `${rect.width * scale}px`;
    highlight.style.height = `${rect.height * scale}px`;
}

function enablePDFSourceRegionEditing(
    pageElement: HTMLElement,
    highlight: HTMLElement,
    page: PDFSourcePageImage,
    rect: PDF_Rect
) {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    let syncRect = () => {
        let zoom = pageElement.clientWidth / page.width;
        let scale = page.scale * zoom;
        if (scale <= 0) {
            return;
        }

        let width = Math.min(highlight.offsetWidth, pageElement.clientWidth);
        let height = Math.min(highlight.offsetHeight, pageElement.clientHeight);
        let left = Math.max(0, Math.min(highlight.offsetLeft, pageElement.clientWidth - width));
        let top = Math.max(0, Math.min(highlight.offsetTop, pageElement.clientHeight - height));
        if (left != highlight.offsetLeft) {
            highlight.style.left = `${left}px`;
        }
        if (top != highlight.offsetTop) {
            highlight.style.top = `${top}px`;
        }
        if (width != highlight.offsetWidth) {
            highlight.style.width = `${width}px`;
        }
        if (height != highlight.offsetHeight) {
            highlight.style.height = `${height}px`;
        }

        rect.x = left / scale;
        rect.width = width / scale;
        rect.height = height / scale;
        rect.y = page.pageHeight - (top + height) / scale;
    };

    new ResizeObserver(syncRect).observe(highlight);
    highlight.onpointerdown = (event) => {
        event.stopPropagation();
        let bounds = highlight.getBoundingClientRect();
        let onResizeHandle = event.clientX >= bounds.right - 18 && event.clientY >= bounds.bottom - 18;
        if (event.button != 0 || onResizeHandle) {
            return;
        }

        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = highlight.offsetLeft;
        startTop = highlight.offsetTop;
        highlight.setPointerCapture(pointerId);
        highlight.classList.add("dragging");
        event.preventDefault();
    };
    highlight.onpointermove = (event) => {
        if (pointerId != event.pointerId) {
            return;
        }
        let left = Math.max(0, Math.min(
            startLeft + event.clientX - startX,
            pageElement.clientWidth - highlight.offsetWidth
        ));
        let top = Math.max(0, Math.min(
            startTop + event.clientY - startY,
            pageElement.clientHeight - highlight.offsetHeight
        ));
        highlight.style.left = `${left}px`;
        highlight.style.top = `${top}px`;
        syncRect();
    };
    let stopDragging = (event: PointerEvent) => {
        if (pointerId != event.pointerId) {
            return;
        }
        if (highlight.hasPointerCapture(pointerId)) {
            highlight.releasePointerCapture(pointerId);
        }
        pointerId = null;
        highlight.classList.remove("dragging");
        syncRect();
    };
    highlight.onpointerup = stopDragging;
    highlight.onpointercancel = stopDragging;
}

function enablePDFSourceZoom(
    viewport: HTMLElement,
    pageElement: HTMLElement,
    image: HTMLImageElement,
    highlight: HTMLElement,
    page: PDFSourcePageImage,
    rect: PDF_Rect,
    label: HTMLElement
) {
    let zoom = 1;
    viewport.addEventListener("wheel", (event) => {
        if (!event.ctrlKey) {
            return;
        }
        event.preventDefault();

        let bounds = viewport.getBoundingClientRect();
        let pointerX = event.clientX - bounds.left;
        let pointerY = event.clientY - bounds.top;
        let contentX = viewport.scrollLeft + pointerX;
        let contentY = viewport.scrollTop + pointerY;
        let nextZoom = Math.min(4, Math.max(0.5, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (nextZoom == zoom) {
            return;
        }

        let ratio = nextZoom / zoom;
        zoom = nextZoom;
        layoutPDFSourcePage(pageElement, image, highlight, page, rect, zoom);
        viewport.scrollLeft = contentX * ratio - pointerX;
        viewport.scrollTop = contentY * ratio - pointerY;
        label.textContent = `Page ${rect.page} · ${Math.round(zoom * 100)}% · Drag page · Adjust box · Ctrl+wheel to zoom`;
    }, {passive: false});
}

function centerPDFSource(viewport: HTMLElement, page: PDFSourcePageImage, rect: PDF_Rect) {
    let centerX = (rect.x + rect.width / 2) * page.scale;
    let centerY = (page.pageHeight - rect.y - rect.height / 2) * page.scale;
    viewport.scrollLeft = centerX - viewport.clientWidth / 2;
    viewport.scrollTop = centerY - viewport.clientHeight / 2;
}

async function createPDFSourcePreview(source: PDFSourceLocation, inlineElement?: HTMLElement) {
    let pageImage = await sourcePageImage(source.page);
    if (!pageImage) {
        throw new Error("Could not render the source PDF area");
    }

    let preview = document.createElement("span");
    preview.className = "pdf-source-preview";
    preview.dataset.exportExclude = "";

    let viewport = document.createElement("span");
    viewport.className = "pdf-source-viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", `Source PDF page ${source.rect.page}; drag to move; Control plus wheel to zoom`);
    let pageElement = document.createElement("span");
    pageElement.className = "pdf-source-page";
    let image = document.createElement("img");
    image.src = pageImage.src;
    image.alt = `Source PDF page ${source.rect.page}`;
    image.width = pageImage.width;
    image.height = pageImage.height;
    image.draggable = false;
    let highlight = document.createElement("span");
    highlight.className = "pdf-source-highlight";
    pageElement.append(image, highlight);
    viewport.appendChild(pageElement);
    let pageLabel = document.createElement("small");
    let pageStatus = document.createElement("span");
    pageStatus.textContent = `Page ${source.rect.page} · 100% · Drag page · Adjust box · Ctrl+wheel to zoom`;
    pageLabel.appendChild(pageStatus);
    if (inlineElement) {
        let showImage = document.createElement("button");
        showImage.type = "button";
        showImage.className = "text-button";
        showImage.textContent = "Show image";
        showImage.onclick = async () => {
            showImage.disabled = true;
            showImage.textContent = "Loading image…";
            try {
                await showPDFImagesInline(null, [inlineElement], [source], preview);
            }
            catch (error) {
                console.warn("Failed to show the PDF area inline", error);
                showImage.textContent = "Image unavailable";
            }
        };
        pageLabel.appendChild(showImage);
    }
    preview.append(viewport, pageLabel);
    layoutPDFSourcePage(pageElement, image, highlight, pageImage, source.rect, 1);
    enableDragScrolling(viewport);
    enablePDFSourceRegionEditing(pageElement, highlight, pageImage, source.rect);
    enablePDFSourceZoom(viewport, pageElement, image, highlight, pageImage, source.rect, pageStatus);
    requestAnimationFrame(() => centerPDFSource(viewport, pageImage, source.rect));
    return preview;
}

function combinedPDFSource(sources: PDFSourceLocation[]) {
    let first = sources[0];
    let x = Math.min(...sources.map((source) => source.rect.x));
    let y = Math.min(...sources.map((source) => source.rect.y));
    let right = Math.max(...sources.map((source) => source.rect.x + source.rect.width));
    let top = Math.max(...sources.map((source) => source.rect.y + source.rect.height));
    return {page: first.page, rect: {page: first.rect.page, x, y, width: right - x, height: top - y}};
}

function selectedSourceBlocks(elements: HTMLElement[]) {
    return [...new Set(elements.map((element) =>
        element.closest<HTMLElement>("#main > *") ?? element
    ))];
}

async function cropPDFSourcePage(page: PDFSourcePageImage, rect: PDF_Rect) {
    let image = new Image();
    image.src = page.src;
    await image.decode();

    let scale = page.scale;
    let sourceX = Math.max(0, Math.floor(rect.x * scale));
    let sourceY = Math.max(0, Math.floor((page.pageHeight - rect.y - rect.height) * scale));
    let sourceWidth = Math.min(page.width - sourceX, Math.ceil(rect.width * scale));
    let sourceHeight = Math.min(page.height - sourceY, Math.ceil(rect.height * scale));
    if (sourceWidth <= 0 || sourceHeight <= 0) {
        return "";
    }

    let crop = document.createElement("canvas");
    crop.width = sourceWidth;
    crop.height = sourceHeight;
    let context = crop.getContext("2d");
    if (!context) {
        return "";
    }
    context.fillStyle = "white";
    context.fillRect(0, 0, sourceWidth, sourceHeight);
    context.drawImage(
        image,
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

async function showPDFImagesInline(
    range: Range | null,
    elements: HTMLElement[],
    sources: PDFSourceLocation[],
    panel: HTMLElement
) {
    let images = await Promise.all(sources.map(async (source) => {
        let page = await sourcePageImage(source.page);
        if (!page) {
            throw new Error("Could not render the selected source PDF area");
        }
        let src = await cropPDFSourcePage(page, source.rect);
        if (!src) {
            throw new Error("Could not crop the selected source PDF area");
        }
        let image = document.createElement("img");
        image.className = "pdf-inline-source-image";
        image.src = src;
        image.alt = `Original PDF image from page ${source.rect.page}`;
        return image;
    }));

    let replacement = document.createElement("span");
    replacement.className = "pdf-inline-source";
    replacement.append(...images);
    let restore = document.createElement("button");
    restore.type = "button";
    restore.className = "text-button pdf-inline-restore";
    restore.textContent = "Show HTML";
    restore.dataset.exportExclude = "";
    replacement.appendChild(restore);

    let exactInlineRange =
        range != null &&
        elements.length == 1 &&
        elements[0].contains(range.startContainer) &&
        elements[0].contains(range.endContainer);
    panel.remove();
    window.getSelection()?.removeAllRanges();
    let figure = range == null && elements.length == 1 && elements[0].closest<HTMLElement>("figure");
    if (figure && elements[0].tagName == "FIGCAPTION") {
        let originalImages = Array.from(figure.querySelectorAll<HTMLImageElement>(":scope > img"));
        let hiddenStates = originalImages.map((image) => image.hidden);
        replacement.classList.add("pdf-inline-source-block", "pdf-inline-figure");
        restore.textContent = "Restore image";
        figure.insertBefore(replacement, elements[0]);
        originalImages.forEach((image) => image.hidden = true);
        restore.onclick = () => {
            originalImages.forEach((image, index) => image.hidden = hiddenStates[index]);
            replacement.remove();
        };
        return;
    }

    if (exactInlineRange && range) {
        let original = range.extractContents();
        range.insertNode(replacement);
        restore.onclick = () => replacement.replaceWith(original);
        return;
    }

    let blocks = selectedSourceBlocks(elements);
    let hiddenStates = blocks.map((block) => block.hidden);
    replacement.classList.add("pdf-inline-source-block");
    blocks[0].insertAdjacentElement("beforebegin", replacement);
    blocks.forEach((block) => block.hidden = true);
    restore.onclick = () => {
        blocks.forEach((block, index) => block.hidden = hiddenStates[index]);
        replacement.remove();
    };
}

async function showPDFSelection(
    sources: PDFSourceLocation[],
    elements: HTMLElement[],
    anchor: HTMLElement,
    range: Range
) {
    document.querySelector(".pdf-selection-preview")?.remove();

    let panel = document.createElement("section");
    panel.className = "pdf-selection-preview";
    panel.dataset.exportExclude = "";
    let header = document.createElement("header");
    header.textContent = "PDF selection";
    let actions = document.createElement("span");
    let showImage = document.createElement("button");
    showImage.type = "button";
    showImage.className = "text-button";
    showImage.textContent = "Show image";
    showImage.disabled = true;
    let close = document.createElement("button");
    close.type = "button";
    close.className = "text-button";
    close.textContent = "Close";
    close.onclick = () => panel.remove();
    actions.append(showImage, close);
    header.appendChild(actions);
    panel.appendChild(header);
    anchor.insertAdjacentElement("afterend", panel);

    let byPage = new Map<number, PDFSourceLocation[]>();
    for (let source of sources) {
        let pageSources = byPage.get(source.rect.page) ?? [];
        pageSources.push(source);
        byPage.set(source.rect.page, pageSources);
    }

    let combinedSources = [...byPage.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, pageSources]) => combinedPDFSource(pageSources));
    try {
        let previews = await Promise.all(
            combinedSources.map((source) => createPDFSourcePreview(source))
        );
        panel.append(...previews);
        showImage.disabled = false;
        showImage.onclick = async () => {
            showImage.disabled = true;
            showImage.textContent = "Loading image…";
            try {
                await showPDFImagesInline(range, elements, combinedSources, panel);
            }
            catch (error) {
                console.warn("Failed to show the selected PDF areas inline", error);
                showImage.textContent = "Image unavailable";
            }
        };
    }
    catch (error) {
        console.warn("Failed to render the selected PDF areas", error);
        let message = document.createElement("small");
        message.textContent = "PDF selection unavailable";
        panel.appendChild(message);
    }
}

function updatePDFSelection() {
    if (!pdfSelectionButton) {
        return;
    }
    let selection = window.getSelection();
    let main = document.getElementById("main");
    if (!selection || selection.isCollapsed || selection.rangeCount == 0 || !main) {
        pdfSelectionButton.hidden = true;
        return;
    }

    let range = selection.getRangeAt(0);
    let elements = Array.from(main.querySelectorAll<HTMLElement>(
        ":scope > .source-linked, :scope > figure > figcaption.source-linked"
    ));
    let selected = elements.filter((element) => {
        try {
            return range.intersectsNode(element) && pdfSourceLocations.has(element);
        }
        catch {
            return false;
        }
    });
    if (selected.length == 0) {
        pdfSelectionButton.hidden = true;
        return;
    }

    selectedPDFSources = selected
        .map((element) => pdfSourceLocations.get(element))
        .filter((source): source is PDFSourceLocation => source != null);
    selectedPDFElements = selected;
    selectedPDFAnchor = selected[selected.length - 1].closest<HTMLElement>("#main > *") ?? selected[selected.length - 1];
    selectedPDFRange = range.cloneRange();

    let rects = range.getClientRects();
    let rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    pdfSelectionButton.hidden = false;
    let width = pdfSelectionButton.offsetWidth;
    let height = pdfSelectionButton.offsetHeight;
    pdfSelectionButton.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right + 6))}px`;
    pdfSelectionButton.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 6))}px`;
}

function enablePDFSelection() {
    document.querySelector(".pdf-selection-preview")?.remove();
    if (pdfSelectionButton) {
        pdfSelectionButton.hidden = true;
        return;
    }

    let button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-selection-button";
    button.textContent = "PDF selection";
    button.dataset.exportExclude = "";
    button.hidden = true;
    button.onpointerdown = (event) => event.preventDefault();
    button.onclick = async () => {
        let sources = [...selectedPDFSources];
        let elements = [...selectedPDFElements];
        let anchor = selectedPDFAnchor;
        let range = selectedPDFRange?.cloneRange();
        button.hidden = true;
        if (!anchor || !range || sources.length == 0 || elements.length == 0) {
            return;
        }
        // 選択範囲は cloneRange() で保持済みなので、追加する PDF パネルまで
        // ブラウザの選択表示に巻き込まれないよう画面上の選択だけ解除する。
        window.getSelection()?.removeAllRanges();
        button.disabled = true;
        button.textContent = "Loading PDF…";
        await showPDFSelection(sources, elements, anchor, range);
        button.textContent = "PDF selection";
        button.disabled = false;
    };
    document.body.appendChild(button);
    pdfSelectionButton = button;
    document.addEventListener("selectionchange", () => requestAnimationFrame(updatePDFSelection));
}

function attachPDFSourceToggle(element: HTMLElement) {
    let source = pdfSourceLocations.get(element);
    if (!source) {
        return;
    }

    let toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "text-button paragraph-toggle pdf-source-toggle";
    toggle.textContent = "PDF";
    toggle.dataset.exportExclude = "";
    toggle.setAttribute("aria-label", `Show source PDF page ${source.rect.page}`);
    toggle.setAttribute("aria-expanded", "false");

    let preview: HTMLElement | null = null;
    toggle.onclick = async () => {
        if (preview) {
            setPDFSourceVisible(toggle, preview, preview.hasAttribute("hidden"), source.rect.page);
            return;
        }

        toggle.disabled = true;
        toggle.textContent = "Loading PDF…";
        try {
            preview = await createPDFSourcePreview(source, element);
            if (element.tagName == "FIGCAPTION" && element.parentElement) {
                element.parentElement.insertBefore(preview, element);
            }
            else {
                element.appendChild(preview);
            }
            setPDFSourceVisible(toggle, preview, true, source.rect.page);
        }
        catch (error) {
            console.warn("Failed to render the source PDF area", error);
            toggle.textContent = "PDF unavailable";
        }
        finally {
            toggle.disabled = false;
        }
    };
    element.classList.add("source-linked");
    element.appendChild(toggle);
}

function attachTranslation(element: HTMLElement, translatedText: string) {
    let pdfToggle = element.querySelector<HTMLElement>(":scope > .pdf-source-toggle");
    let pdfPreview = element.querySelector<HTMLElement>(":scope > .pdf-source-preview");
    pdfToggle?.remove();
    pdfPreview?.remove();

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
    toggle.className = "text-button paragraph-toggle translation-toggle";
    toggle.onclick = () => setElementOriginalVisible(element, original.hasAttribute("hidden"));

    element.classList.add("translatable");
    element.lang = "ja";
    element.append(
        translated,
        toggle,
        ...(pdfToggle ? [pdfToggle] : []),
        original,
        ...(pdfPreview ? [pdfPreview] : [])
    );
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
            let sourceText = translatableText(element);
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
        show(nodes, pageProxies);
        if (progress) {
            progress.hidden = true;
        }
        enableHTMLExport(sourceName);
        void enableTranslation();
    });
}

