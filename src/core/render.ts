import {PDF_Node, PDF_Rect, PDF_RenderCanvas} from "./extractor";

export interface PDF_ImageCanvas extends PDF_RenderCanvas {
    toDataURL(type?: string): string;
}

export type PDF_CanvasFactory = (width: number, height: number) => PDF_ImageCanvas;

interface RenderedPageCanvas {
    canvas: PDF_ImageCanvas;
    pageHeight: number;
    scale: number;
}

// Canvas の生成だけを CLI / viewer に委ね、描画倍率と切り出し座標を共有する。
export async function renderPageCanvas(page: any, createCanvas: PDF_CanvasFactory, scale = 4): Promise<RenderedPageCanvas | null> {
    let viewport = page.getViewport({scale});
    let canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    let context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({canvasContext: context, viewport}).promise;
    return {canvas, pageHeight: page.getViewport({scale: 1}).height, scale};
}

export function cropRectFromPage(rendered: RenderedPageCanvas, rect: PDF_Rect, createCanvas: PDF_CanvasFactory) {
    let {canvas, pageHeight, scale} = rendered;
    let x = Math.max(0, Math.floor(rect.x * scale));
    let y = Math.max(0, Math.floor((pageHeight - rect.y - rect.height) * scale));
    let width = Math.min(canvas.width - x, Math.ceil(rect.width * scale));
    let height = Math.min(canvas.height - y, Math.ceil(rect.height * scale));
    if (width <= 0 || height <= 0) return "";

    let crop = createCanvas(width, height);
    let context = crop.getContext("2d");
    if (!context) return "";
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    // node-canvas も同じ drawImage API を持つ。
    context.drawImage(canvas as HTMLCanvasElement, x, y, width, height, 0, 0, width, height);
    return crop.toDataURL("image/png");
}

// ページごとに一度だけ描画し、図表・独立数式・行内数式の PNG を付与する。
export async function attachNodeImages(nodes: PDF_Node[], pages: any[], createCanvas: PDF_CanvasFactory) {
    let renderedPages = new Map<number, RenderedPageCanvas | null>();
    for (let node of nodes) {
        let images = [...(node.rect ? [node] : []), ...(node.inlineImages ?? [])];
        for (let image of images) {
            let rect = image.rect!;
            if (!renderedPages.has(rect.page)) {
                let page = pages[rect.page - 1];
                if (!page) continue;
                renderedPages.set(rect.page, await renderPageCanvas(page, createCanvas));
            }
            let rendered = renderedPages.get(rect.page);
            if (rendered) image.imageSrc = cropRectFromPage(rendered, rect, createCanvas);
        }
    }
}
