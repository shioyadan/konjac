"use strict";

// 拡張版、CLI、Web版で共有する、PDF.jsのTextItem群からHTML構造を推定する抽出器。
// 処理の流れ:
//   1. TextItem を座標付き TextPart に正規化する。
//   2. y 座標と x 座標から TextLine を復元する。
//   3. 文書全体から本文フォントサイズと本文幅を推定する。
//   4. ページ番号などの一般的な装飾を落とし、読み順を 2 段組み前提で整える。
//   5. 本文・キャプションを境界に図表の所属範囲を決め、マスク上の内容を画像領域にまとめる。
//   6. 本文・別の式番号を境界に表示数式を集め、残りを title/heading/text に分類する。
//   7. 連続する本文行を段落にまとめる。
//   8. 図表をまたいで分割された段落を結合し、HTML タグへ対応づける。

export enum PDF_NodeType {
    // 通常の本文段落。
    TEXT = 1,
    // 論文タイトル。
    TITLE = 2,
    // ABSTRACT や章・節見出し。
    HEADING = 3,
    // Figure/Table のキャプション。
    CAPTION = 4,
    // Figure/Table を PDF ページから切り出して表示するためのノード。
    FIGURE = 5,
    // 表示数式を PDF ページから切り出して表示するためのノード。
    EQUATION = 6,
    // 論文タイトル直下から抽出した著者名。
    AUTHOR = 7,
    // 著者名直下の所属・所在地・連絡先。
    AFFILIATION = 8
};

// PDF ページ上の矩形。PDF.js の page.render で切り出すため、座標系は PDF と同じ左下原点。
export interface PDF_Rect {
    // 1 始まりのページ番号。
    page: number;
    // 矩形左下の x 座標。
    x: number;
    // 矩形左下の y 座標。
    y: number;
    // 矩形の幅。
    width: number;
    // 矩形の高さ。
    height: number;
}

// PDF の描画命令から取り出した線・パス・画像などの外接矩形。
export interface PDF_GraphicObject extends PDF_Rect {
    // 描画命令のおおまかな種類。
    kind: "path" | "image" | "form";
    // 線幅。パスの bbox が 0 幅/高さになる場合の補正に使う。
    strokeWidth?: number;
}

// 描画済みページの占有画素。左下原点、1セルあたり cellSize PDF ポイント。
export interface PDF_InkMask {
    width: number;
    height: number;
    cellSize: number;
    cells: Uint8Array;
}

// 1 ページ分の入力。既存 API 互換のため unknown[] だけを渡すこともできる。
export interface PDF_PageInput {
    // PDF.js の getTextContent().items。
    items: unknown[];
    ink?: PDF_InkMask;
    // PDF.js の getOperatorList() から得た描画オブジェクト。
    graphics?: PDF_GraphicObject[];
    // page.getViewport({scale: 1}).width。未指定なら本文座標から推定する。
    width?: number;
    // page.getViewport({scale: 1}).height。未指定なら本文座標から推定する。
    height?: number;
}

// HTML に変換する前の構造ノード。
export class PDF_Node {
    // ノード内のプレーンテキスト。
    str: string;
    // 本文、タイトル、著者・所属、見出し、キャプション、図表、数式の種別。
    type: PDF_NodeType;
    // 図表・数式ノードの場合、PDF ページから切り出す矩形。
    rect?: PDF_Rect;
    // このノードの元テキストがある範囲。PDF 上の原文表示に使う。
    sourceRect?: PDF_Rect;
    // CLI/viewer が rect から生成した画像。extractor 自体は画像生成を行わない。
    imageSrc?: string;

    constructor(str: string, type: PDF_NodeType, rect?: PDF_Rect, sourceRect?: PDF_Rect) {
        this.str = str;
        this.type = type;
        if (rect) {
            this.rect = rect;
        }
        if (sourceRect) {
            this.sourceRect = sourceRect;
        }
    }
};

const FIGURE_DISPLAY_SCALE = 2.25;
const FIGURE_DISPLAY_MIN_WIDTH = 400;
const FIGURE_DISPLAY_MAX_WIDTH = 840;

// PDF.js の TextItem のうち、この抽出器が使うフィールドだけを表す型。
export interface PDF_TextItemLike {
    // PDF.js が抽出した文字列。
    str?: string;
    // PDF 座標変換行列。transform[4], transform[5] が描画位置になる。
    transform?: number[];
    // 文字列の描画幅。
    width?: number;
    // 文字列の描画高さ。フォントサイズ推定のフォールバックに使う。
    height?: number;
    // PDF.js が付けるフォント名。現状では保持のみで分類には使っていない。
    fontName?: string;
};

// PDF.js の TextItem をページ座標付きの最小単位へ正規化したもの。
interface TextPart {
    // 空白正規化前の文字列。
    text: string;
    // 1 始まりのページ番号。
    page: number;
    // ページ内の x 座標。
    x: number;
    // ページ内の y 座標。
    y: number;
    // この文字片の描画幅。
    width: number;
    // transform から推定したフォントサイズ。
    fontSize: number;
}

// 同じ y 座標付近にある TextPart を横方向に連結した 1 行。
interface TextLine {
    // 行全体を空白正規化して連結した文字列。
    text: string;
    // 1 始まりのページ番号。
    page: number;
    // 行の左端 x 座標。
    x: number;
    // 行の代表 y 座標。
    y: number;
    // 行の描画幅。
    width: number;
    // 行内で最も大きいフォントサイズ。
    fontSize: number;
    // この行を構成する元の文字片。
    parts: TextPart[];
}

// ページごとの大きさと本文領域の概算。
interface PageMetrics {
    // 1 始まりのページ番号。
    page: number;
    // PDF ページ幅。
    width: number;
    // PDF ページ高さ。
    height: number;
    // TextLine から見た本文左端。
    minX: number;
    // TextLine から見た本文右端。
    maxX: number;
}

// 本文行の左端と baseline 間隔をページ・カラムごとにまとめたもの。
interface BodyColumnModel {
    // 1 始まりのページ番号。
    page: number;
    // 本文行が揃う左端 x 座標。
    x: number;
    // 同じカラム内の代表的な baseline 間隔。
    yStep: number;
    // 推定に使った baseline 群。
    baselines: number[];
}

interface BodyLayoutModel {
    // ページ内の本文カラム候補。
    columns: BodyColumnModel[];
}

// キャプションから推定した図表ノードと、そのキャプション行の範囲。
interface FigureCandidate {
    // 読み順配列でのキャプション先頭行。
    startIndex: number;
    // 複数行キャプションの最終行。
    endIndex: number;
    // この図表ノードにまとめたキャプション行。
    captionLines: TextLine[];
    // 出力する図表ノード。
    node: PDF_Node;
}

// 右端の式番号を起点に、同じ表示数式へ属する行をまとめた候補。
interface EquationCandidate {
    // 読み順配列で最初に現れる数式行。
    startIndex: number;
    // 本文抽出から除外する、数式を構成する全行。
    lineIndices: number[];
    // PDF ページから切り出して表示する数式ノード。
    node: PDF_Node;
}

// 1ページ目から本文抽出より先に確定するタイトル・著者と、除外する誌面ヘッダー。
interface DocumentMetadata {
    titleLines: TextLine[];
    authorLines: TextLine[];
    affiliationLines: TextLine[];
    ignoredLines: Set<TextLine>;
}

// CLI などで内部の空間分類を確認するためのデバッグ出力。
export interface PDF_DebugMaskDump {
    // 対象ページ。
    page: number;
    // 生成した bitmap の横セル数。
    width: number;
    // 生成した bitmap の縦セル数。
    height: number;
    // 1 セルが表す PDF 座標上の長さ。
    cellSize: number;
    // ブラウザでそのまま確認できる SVG。
    svg: string;
}

export interface PDF_ExtractOptions {
    // 指定された場合だけ、ページごとの属性付き occupancy bitmap を呼び出し側へ渡す。
    debugMaskSink?: (dump: PDF_DebugMaskDump) => void;
    // 指定文字列を含むキャプションだけ、bitmap scan の判断過程を呼び出し側へ渡す。
    debugScanCaption?: string;
    debugScanSink?: (message: string) => void;
}

interface OccupancyMask {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    cellSize: number;
    cells: Uint8Array;
    debugLineCount: number;
    debugGraphicCount: number;
}

type Matrix = [number, number, number, number, number, number];

// 同じ行とみなす y 座標差の許容値。
const LINE_Y_EPSILON = 2.0;
// 同一 y 座標上で別行・別カラムとみなす横方向の隙間。
const COLUMN_GAP = 16.0;
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const OCCUPANCY_CELL_SIZE = 2.0;
const MASK_BODY = 1 << 0;
const MASK_SHAPE = 1 << 1;
const MASK_FLOAT_TEXT = 1 << 2;
const MASK_CAPTION = 1 << 3;
const MASK_HEADING = 1 << 4;
const MASK_OTHER_TEXT = 1 << 5;
const MASK_CROP = 1 << 6;
const MASK_BODY_LAYOUT = 1 << 7;
const MASK_HARD_TEXT_BLOCKER = MASK_BODY_LAYOUT | MASK_CAPTION | MASK_HEADING;
const MASK_CONTENT = MASK_BODY | MASK_SHAPE | MASK_FLOAT_TEXT | MASK_CAPTION | MASK_HEADING | MASK_OTHER_TEXT | MASK_BODY_LAYOUT;

type DebugScanLog = (message: string) => void;
type MaskRange = {x0: number; x1: number; y0: number; y1: number};

function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5]
    ];
}

function asMatrix(value: unknown): Matrix {
    let m = Array.isArray(value) ? value : [];
    return [
        Number(m[0] ?? 1), Number(m[1] ?? 0), Number(m[2] ?? 0),
        Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0)
    ];
}

function transformPoint(m: Matrix, x: number, y: number) {
    return {
        x: m[0] * x + m[2] * y + m[4],
        y: m[1] * x + m[3] * y + m[5]
    };
}

function transformBox(page: number, m: Matrix, box: number[], lineWidth: number, kind: PDF_GraphicObject["kind"]) {
    if (box.length < 4 || !box.every(Number.isFinite)) {
        return null;
    }

    let points = [
        transformPoint(m, box[0], box[1]),
        transformPoint(m, box[2], box[1]),
        transformPoint(m, box[2], box[3]),
        transformPoint(m, box[0], box[3])
    ];
    let minX = Math.min(...points.map((p) => p.x)) - lineWidth / 2;
    let maxX = Math.max(...points.map((p) => p.x)) + lineWidth / 2;
    let minY = Math.min(...points.map((p) => p.y)) - lineWidth / 2;
    let maxY = Math.max(...points.map((p) => p.y)) + lineWidth / 2;

    if (maxX <= minX || maxY <= minY) {
        return null;
    }

    return {page, kind, x: minX, y: minY, width: maxX - minX, height: maxY - minY, strokeWidth: lineWidth};
}

function unionGraphicBox(a: PDF_GraphicObject | null, b: PDF_GraphicObject | null) {
    if (!a) {
        return b;
    }
    if (!b) {
        return a;
    }

    let x = Math.min(a.x, b.x);
    let y = Math.min(a.y, b.y);
    let right = Math.max(a.x + a.width, b.x + b.width);
    let top = Math.max(a.y + a.height, b.y + b.height);
    return {...a, x, y, width: right - x, height: top - y};
}

function operatorPathBox(args: unknown[]) {
    let explicitBox = args[2];
    if (Array.isArray(explicitBox) && explicitBox.length >= 4) {
        return explicitBox.map(Number).slice(0, 4);
    }

    let coords = Array.isArray(args[1]) ? args[1].map(Number).filter(Number.isFinite) : [];
    if (coords.length < 2) {
        return null;
    }

    let xs = coords.filter((_, i) => i % 2 == 0);
    let ys = coords.filter((_, i) => i % 2 == 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function colorComponent(value: unknown) {
    let number = Number(value ?? 0);
    return number > 1 ? number / 255 : number;
}

function rgbColor(args: unknown[]) {
    return [
        colorComponent(args[0]),
        colorComponent(args[1]),
        colorComponent(args[2])
    ] as const;
}

function isNearWhite(color: readonly number[]) {
    return color.length >= 3 && color.every((component) => component >= 0.97);
}

// PDF.js の operator list から、実際に stroke/fill された path と画像の外接矩形を取り出す。
async function extractGraphicsFromPage(page: any, pageNumber: number, ops: Record<string, number>) {
    let operatorList = await page.getOperatorList();
    let graphics: PDF_GraphicObject[] = [];
    let ctm: Matrix = [...IDENTITY_MATRIX];
    let stack: Array<{
        ctm: Matrix;
        lineWidth: number;
        fillColor: readonly number[];
        strokeColor: readonly number[];
        clip: PDF_Rect | null;
    }> = [];
    let lineWidth = 1;
    let fillColor: readonly number[] = [0, 0, 0];
    let strokeColor: readonly number[] = [0, 0, 0];
    let clip: PDF_Rect | null = null;
    let pendingPath: PDF_GraphicObject | null = null;

    function paintPendingPath(usesFill: boolean, usesStroke: boolean) {
        if (pendingPath) {
            let invisibleWhite =
                (!usesFill || isNearWhite(fillColor)) &&
                (!usesStroke || isNearWhite(strokeColor));
            let visiblePath = clip ? intersectRectsLoose(pendingPath, clip) : pendingPath;
            if (!invisibleWhite && visiblePath) {
                graphics.push({...pendingPath, ...visiblePath});
            }
            pendingPath = null;
        }
    }

    function applyPendingClip() {
        if (pendingPath) {
            clip = clip ? intersectRectsLoose(clip, pendingPath) : pendingPath;
            pendingPath = null;
        }
    }

    for (let i = 0; i < operatorList.fnArray.length; i++) {
        let fn = operatorList.fnArray[i];
        let args = operatorList.argsArray[i] ?? [];

        if (fn == ops.save) {
            stack.push({ctm: [...ctm], lineWidth, fillColor, strokeColor, clip});
        }
        else if (fn == ops.restore) {
            let state = stack.pop();
            if (state) {
                ctm = state.ctm;
                lineWidth = state.lineWidth;
                fillColor = state.fillColor;
                strokeColor = state.strokeColor;
                clip = state.clip;
            }
        }
        else if (fn == ops.transform) {
            ctm = multiplyMatrix(ctm, asMatrix(args));
        }
        else if (fn == ops.setLineWidth && typeof args[0] == "number") {
            lineWidth = args[0];
        }
        else if (fn == ops.setFillRGBColor) {
            fillColor = rgbColor(args);
        }
        else if (fn == ops.setStrokeRGBColor) {
            strokeColor = rgbColor(args);
        }
        else if (fn == ops.constructPath) {
            let box = operatorPathBox(args);
            let object = box ? transformBox(pageNumber, ctm, box, lineWidth, "path") : null;
            pendingPath = unionGraphicBox(pendingPath, object);
        }
        else if (
            fn == ops.stroke ||
            fn == ops.closeStroke ||
            fn == ops.fillStroke ||
            fn == ops.eoFillStroke ||
            fn == ops.closeFillStroke ||
            fn == ops.closeEOFillStroke
        ) {
            let strokeOnly = fn == ops.stroke || fn == ops.closeStroke;
            paintPendingPath(!strokeOnly, true);
        }
        else if (
            fn == ops.fill ||
            fn == ops.eoFill
        ) {
            paintPendingPath(true, false);
        }
        else if (fn == ops.clip || fn == ops.eoClip || fn == ops.endPath) {
            if (fn == ops.clip || fn == ops.eoClip) {
                applyPendingClip();
            }
            else {
                pendingPath = null;
            }
        }
        else if (fn == ops.paintImageXObject || fn == ops.paintJpegXObject || fn == ops.paintInlineImageXObject) {
            let object = transformBox(pageNumber, ctm, [0, 0, 1, 1], 0, "image");
            let visibleObject = object && clip ? intersectRectsLoose(object, clip) : object;
            if (object && visibleObject) {
                graphics.push({...object, ...visibleObject});
            }
        }
        else if (fn == ops.paintFormXObjectBegin) {
            ctm = multiplyMatrix(ctm, asMatrix(args[0]));
        }
    }

    return graphics;
}

// Canvas の生成だけを呼び出し側へ委ね、CLI とブラウザで同じマスクを作る。
export interface PDF_RenderCanvas {
    width: number;
    height: number;
    getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}

async function renderPageInk(page: any, createCanvas: (width: number, height: number) => PDF_RenderCanvas): Promise<PDF_InkMask> {
    let viewport = page.getViewport({scale: 1});
    let canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    let context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot create a PDF rendering context");
    await page.render({canvasContext: context, viewport}).promise;
    let data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cellSize = OCCUPANCY_CELL_SIZE;
    let width = Math.ceil(viewport.width / cellSize), height = Math.ceil(viewport.height / cellSize);
    let cells = new Uint8Array(width * height);
    // 低解像度へ直接描画すると細線が消えるため、等倍の画素を OR して縮小する。
    for (let y = 0; y < canvas.height; y++) {
        let row = Math.max(0, Math.floor((viewport.height - y - 1) / cellSize)) * width;
        for (let x = 0; x < canvas.width; x++) {
            let offset = (y * canvas.width + x) * 4;
            if (Math.min(data[offset], data[offset + 1], data[offset + 2]) < 240) cells[row + Math.floor(x / cellSize)] = 1;
        }
    }
    canvas.width = canvas.height = 0;
    return {width, height, cellSize, cells};
}

// CLI/viewer からは TextContent と Graphics を別々に扱わず、ページ入力としてまとめて渡す。
export async function extractPageInputFromPDFPage(
    page: any, pageNumber: number, ops: Record<string, number>,
    createCanvas?: (width: number, height: number) => PDF_RenderCanvas
): Promise<PDF_PageInput> {
    let viewport = page.getViewport({scale: 1});
    let [textContent, graphics] = await Promise.all([
        page.getTextContent(),
        extractGraphicsFromPage(page, pageNumber, ops)
    ]);

    // CropBox の移動とページ回転を、描画時と同じページ座標へ正規化する。
    let pageTransform = multiplyMatrix([1, 0, 0, -1, 0, viewport.height], asMatrix(viewport.transform));
    let input: PDF_PageInput = {
        items: textContent.items.map((item: PDF_TextItemLike) => item.transform ? {
            ...item, transform: multiplyMatrix(pageTransform, asMatrix(item.transform))
        } : item),
        graphics: graphics.map((graphic) => ({
            ...graphic,
            ...transformBox(pageNumber, pageTransform, [graphic.x, graphic.y, rectRight(graphic), rectTop(graphic)], 0, graphic.kind),
            strokeWidth: graphic.strokeWidth
        })),
        width: viewport.width,
        height: viewport.height
    };
    if (createCanvas && hasFullPageImage(input.graphics ?? [], {page: pageNumber, width: viewport.width, height: viewport.height, minX: 0, maxX: viewport.width}) &&
        buildLinesForPage(input.items, pageNumber).some((line) => isCaptionLine(line))) {
        input.ink = await renderPageInk(page, createCanvas);
    }
    return input;
}

// PDF.js の transform から文字列、座標、フォントサイズを取り出す。
function textItemToPart(textItemArg: unknown, page: number) {
    let textItem = textItemArg as PDF_TextItemLike;
    if (typeof textItem.str != "string" || textItem.str.trim() == "") {
        return null;
    }

    let transform = textItem.transform ?? [];
    let fontSize =
        Math.hypot(transform[2] ?? 0, transform[3] ?? 0) ||
        Math.hypot(transform[0] ?? 0, transform[1] ?? 0) ||
        textItem.height ||
        0;

    return {
        text: textItem.str,
        page,
        x: transform[4] ?? 0,
        y: transform[5] ?? 0,
        width: textItem.width ?? 0,
        fontSize
    };
}

// PDF 内の細かい空白分割を、HTML 出力しやすい空白へ正規化する。
function normalizeText(str: string) {
    return str.replace(/\s+/g, " ").trim();
}

// 同一行上の TextPart を x 座標順に連結する。
function partsToText(parts: TextPart[]) {
    let text = "";
    let prevEnd = 0;

    for (let part of parts) {
        let token = part.text.trim();
        if (token == "") {
            continue;
        }

        if (text != "" && part.x - prevEnd > 1.0) {
            text += " ";
        }
        text += token;
        prevEnd = Math.max(prevEnd, part.x + part.width);
    }

    return normalizeText(text);
}

// TextPart 群から、行全体の座標・幅・代表フォントサイズを計算する。
function partsToLine(parts: TextPart[]) {
    let nonSpaceParts = parts.filter((part) => part.text.trim() != "");
    if (nonSpaceParts.length == 0) {
        return null;
    }

    let x = Math.min(...nonSpaceParts.map((part) => part.x));
    let endX = Math.max(...nonSpaceParts.map((part) => part.x + part.width));
    let fontSize = Math.max(...nonSpaceParts.map((part) => part.fontSize));

    return {
        text: partsToText(parts),
        page: nonSpaceParts[0].page,
        x,
        y: nonSpaceParts.reduce((sum, part) => sum + part.y, 0) / nonSpaceParts.length,
        width: endX - x,
        fontSize,
        parts: nonSpaceParts
    };
}

function dominantFontSize(parts: TextPart[], fallback: number) {
    let weightedParts = parts
        .map((part) => ({
            fontSize: part.fontSize,
            weight: Math.max(part.width, part.text.trim().length)
        }))
        .filter((part) => part.weight > 0)
        .sort((a, b) => a.fontSize - b.fontSize);

    if (weightedParts.length == 0) {
        return fallback;
    }

    let totalWeight = weightedParts.reduce((sum, part) => sum + part.weight, 0);
    let halfway = totalWeight / 2;
    let accumulated = 0;
    for (let part of weightedParts) {
        accumulated += part.weight;
        if (accumulated >= halfway) {
            return part.fontSize;
        }
    }

    return weightedParts[weightedParts.length - 1].fontSize;
}

function lineDominantFontSize(line: TextLine) {
    return dominantFontSize(line.parts, line.fontSize);
}

function lineWithText(line: TextLine, text: string): TextLine {
    return {
        ...line,
        text
    };
}

// 複数ページにまたがる段落では、先頭ページ側のテキスト範囲を代表位置として返す。
function sourceRectFromLines(lines: TextLine[]) {
    let page = lines[0]?.page;
    let pageLines = lines.filter((line) => line.page == page);
    if (page == null || pageLines.length == 0) {
        return undefined;
    }

    let x = Math.min(...pageLines.map((line) => line.x));
    let right = Math.max(...pageLines.map((line) => line.x + line.width));
    let y = Math.min(...pageLines.map((line) => line.y - line.fontSize * 0.25));
    let top = Math.max(...pageLines.map((line) => line.y + line.fontSize));
    return {page, x, y, width: right - x, height: top - y};
}

// 1 ページ分の TextItem を y 座標でまとめ、TextLine に復元する。
function buildLinesForPage(textItems: unknown[], page: number) {
    let parts = textItems
        .map((textItem) => textItemToPart(textItem, page))
        .filter((part): part is TextPart => part != null)
        .sort((a, b) => b.y - a.y || a.x - b.x);

    let rows: TextPart[][] = [];
    for (let part of parts) {
        let row = rows[rows.length - 1];
        if (!row || Math.abs(row[0].y - part.y) > LINE_Y_EPSILON) {
            rows.push([part]);
        }
        else {
            row.push(part);
        }
    }

    let lines: TextLine[] = [];
    for (let row of rows) {
        row.sort((a, b) => a.x - b.x);
        let lineParts: TextPart[] = [];
        let prevEnd = 0;

        for (let part of row) {
            if (lineParts.length != 0 && part.x - prevEnd > COLUMN_GAP) {
                let line = partsToLine(lineParts);
                if (line && line.text != "") {
                    lines.push(line);
                }
                lineParts = [];
            }

            lineParts.push(part);
            prevEnd = Math.max(prevEnd, part.x + part.width);
        }

        let line = partsToLine(lineParts);
        if (line && line.text != "") {
            lines.push(line);
        }
    }

    return lines;
}

// 文書中で最もよく使われる本文フォントサイズを推定する。
function estimateBodyFontSize(lines: TextLine[]) {
    let counts = new Map<number, number>();

    for (let line of lines) {
        let fontSize = lineDominantFontSize(line);
        if (fontSize < 7 || fontSize > 12.5 || line.text.length < 20) {
            continue;
        }
        let key = Math.round(fontSize * 2) / 2;
        counts.set(key, (counts.get(key) ?? 0) + line.text.length);
    }

    let bestFontSize = 10;
    let bestCount = 0;
    for (let [fontSize, count] of counts) {
        if (count > bestCount) {
            bestFontSize = fontSize;
            bestCount = count;
        }
    }

    return bestFontSize;
}

function median(values: number[], fallback: number) {
    if (values.length == 0) {
        return fallback;
    }

    let sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function pageItems(page: unknown[] | PDF_PageInput) {
    return Array.isArray(page) ? page : page.items;
}

function pageGraphics(page: unknown[] | PDF_PageInput) {
    return Array.isArray(page) ? [] : page.graphics ?? [];
}

function finiteNumber(value: unknown): value is number {
    return typeof value == "number" && Number.isFinite(value);
}

// 呼び出し側から渡されたページサイズを優先し、なければ TextLine の座標から概算する。
function estimatePageMetrics(lines: TextLine[], pages: Array<unknown[] | PDF_PageInput>) {
    let metrics = new Map<number, PageMetrics>();

    for (let i = 0; i < pages.length; i++) {
        let page = pages[i];
        let width = !Array.isArray(page) && finiteNumber(page.width) ? page.width : 612;
        let height = !Array.isArray(page) && finiteNumber(page.height) ? page.height : 792;
        metrics.set(i + 1, {
            page: i + 1,
            width,
            height,
            minX: Number.POSITIVE_INFINITY,
            maxX: 0
        });
    }

    for (let line of lines) {
        let metric = metrics.get(line.page);
        if (!metric) {
            metric = {
                page: line.page,
                width: 612,
                height: 792,
                minX: Number.POSITIVE_INFINITY,
                maxX: 0
            };
            metrics.set(line.page, metric);
        }

        metric.minX = Math.min(metric.minX, line.x);
        metric.maxX = Math.max(metric.maxX, line.x + line.width);
        if (!finiteNumber((pages[line.page - 1] as PDF_PageInput | undefined)?.width)) {
            metric.width = Math.max(metric.width, line.x + line.width + 36);
        }
        if (!finiteNumber((pages[line.page - 1] as PDF_PageInput | undefined)?.height)) {
            metric.height = Math.max(metric.height, line.y + line.fontSize + 36);
        }
    }

    for (let metric of metrics.values()) {
        if (!Number.isFinite(metric.minX)) {
            metric.minX = 36;
            metric.maxX = metric.width - 36;
        }
    }

    return metrics;
}

// ページ番号など、論文本体ではない固定要素を落とす。
function isPageDecoration(line: TextLine, metric?: PageMetrics) {
    let text = line.text.trim();
    return (
        /^\d+$/.test(text) && line.fontSize <= 12 && (!metric || line.y < 36 || line.y > metric.height - 36) ||
        /Authorized licensed use limited to:|IEEE Xplore\. Restrictions apply\./.test(text) ||
        /^(?:IEEE Micro|Published by the IEEE Computer Society|March\/April \d{4}|COOL CHIPS)(?:\s+|$)/.test(text) ||
        /^0?272-1732\b/.test(text) ||
        /^Digital Object Identifier\b/.test(text) ||
        /^Date of publication\b/.test(text) ||
        /^\d{1,2}\s+[A-Z][a-z]+\s+\d{4}\.?$/.test(text)
    );
}

const CAPTION_NUMBER_PATTERN = "(?:\\d+(?:\\.\\d+)*|[IVXLCDM]+)";
const CAPTION_LINE_PATTERN = new RegExp(`^(?:Figure|Fig\\.|Table)\\s+${CAPTION_NUMBER_PATTERN}(?!\\.\\d)(?:\\s*[:.]|$)`, "i");
const FIG_DOT_CAPTION_PATTERN = new RegExp(`^Fig\\.\\s+${CAPTION_NUMBER_PATTERN}(?!\\.\\d)\\s*\\.`, "i");
const BARE_CAPTION_LABEL_PATTERN = new RegExp(`^(?:Figure|Fig\\.|Table)\\s+${CAPTION_NUMBER_PATTERN}(?!\\.\\d)\\s*[:.]?$`, "i");
const TABLE_CAPTION_PATTERN = new RegExp(`^Table\\s+${CAPTION_NUMBER_PATTERN}\\b`, "i");
const ALGORITHM_CAPTION_PATTERN = /^Algorithm\s+\d+\b/i;

// 図表キャプションの先頭行を検出する。
function isCaptionLine(line: TextLine, bodyFontSize?: number, columnWidth?: number) {
    if (!CAPTION_LINE_PATTERN.test(line.text)) {
        return false;
    }

    // "Fig. 12. The ..." のような略記参照だけは本文行頭に出ることがある。
    // "Figure 12. ..." や "Table 1. ..." は長いキャプションでも拾う。
    if (
        bodyFontSize != null &&
        columnWidth != null &&
        /^Fig\./i.test(line.text) &&
        FIG_DOT_CAPTION_PATTERN.test(line.text) &&
        isParagraphLikeLine(line, bodyFontSize, columnWidth)
    ) {
        return false;
    }

    return true;
}

function isTableCaption(text: string) {
    return TABLE_CAPTION_PATTERN.test(text);
}

function isAlgorithmCaptionLine(line: TextLine) {
    return ALGORITHM_CAPTION_PATTERN.test(line.text);
}

// 1 ページ目で本文より十分大きい行を論文タイトル候補とする。
function isTitleLine(line: TextLine, bodyFontSize: number) {
    return line.page == 1 && lineDominantFontSize(line) >= bodyFontSize + 5;
}

// 所属・所在地・連絡先に典型的な語を検出し、著者名と区別する。
function looksLikeAffiliationText(text: string) {
    return (
        /(?:\b(?:University|Institute|Institution|Corporation|Laborator(?:y|ies)|Research\s+Center|Centre|School|College|Department|Faculty|Engineering|Email)\b|\bDept\.)/i.test(text) ||
        /^(?:AMD|IBM|Intel|RIKEN|MIT)\b/.test(text.trim()) ||
        /@|https?:|[{}]|\b(?:USA|Japan|Belgium|Germany)\b|,\s*[A-Z]{2}(?:\s|,|$)|\b\d{4,}\b/.test(text)
    );
}

// 氏名に付く脚注記号を落とし、複数行から一つの著者列を作れる形へ正規化する。
function cleanAuthorText(text: string) {
    return text
        .replace(/[•*†‡∗]+/g, "")
        .replace(/\s+,/g, ",")
        .replace(/,\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
}

// 大文字で始まる人名語が複数ある短い行を著者名候補とする。
function looksLikeAuthorText(text: string) {
    let cleaned = cleanAuthorText(text);
    if (cleaned.length < 5 || cleaned.length > 260 || looksLikeAffiliationText(cleaned)) {
        return false;
    }

    let tokens = cleaned.split(/[\s,]+/).filter((token) => token != "");
    let nameTokens = tokens.filter((token) =>
        /^(?:[A-Z][A-Za-z'’\-]+|[A-Z]\.|Jr\.?|Sr\.?)$/.test(token)
    ).length;
    let allowedTokens = nameTokens + tokens.filter((token) => /^(?:and|&|van|von|de|da|del)$/i.test(token)).length;
    return nameTokens >= 2 && allowedTokens >= Math.max(2, tokens.length * 0.55);
}

// 著者名と所属が同一baselineへ結合された場合、TextPart境界で二つの行へ戻す。
function splitMixedAuthorAffiliationLines(lines: TextLine[]) {
    let result: TextLine[] = [];

    for (let line of lines) {
        if (line.page != 1 || line.parts.length < 2) {
            result.push(line);
            continue;
        }

        let splitAt = line.parts.findIndex((part, index) =>
            index > 0 && looksLikeAffiliationText(part.text)
        );
        if (splitAt < 1) {
            result.push(line);
            continue;
        }

        let author = partsToLine(line.parts.slice(0, splitAt));
        let affiliation = partsToLine(line.parts.slice(splitAt));
        if (!author || !affiliation || !looksLikeAuthorText(author.text)) {
            result.push(line);
            continue;
        }

        result.push(author, affiliation);
    }

    return result;
}

// 近いbaselineと同じ大きなフォントを持つ行を、一つのタイトル候補群へまとめる。
function titleLineGroups(lines: TextLine[], bodyFontSize: number, metric: PageMetrics) {
    let candidates = lines
        .filter((line) =>
            line.page == 1 &&
            line.y > metric.height * 0.35 &&
            lineDominantFontSize(line) >= bodyFontSize + 1.5 &&
            !/^\d+(?:\.\d+)*$/.test(line.text.trim()) &&
            !isAbstractHeading(line.text) &&
            !isCaptionLine(line, bodyFontSize, metric.width / 2)
        )
        .sort((a, b) => b.y - a.y || a.x - b.x);
    let groups: TextLine[][] = [];

    for (let line of candidates) {
        let group = groups[groups.length - 1];
        let previous = group?.[group.length - 1];
        let groupFontSize = group ? median(group.map(lineDominantFontSize), lineDominantFontSize(line)) : 0;
        if (
            !group ||
            !previous ||
            previous.y - line.y > Math.max(18, groupFontSize * 1.6) ||
            Math.abs(lineDominantFontSize(line) - groupFontSize) > 1.5
        ) {
            groups.push([line]);
        }
        else {
            group.push(line);
        }
    }

    return groups;
}

// ページ上部で最大のフォント群をタイトルとし、その直下の人名行を著者として抽出する。
function collectDocumentMetadata(
    lines: TextLine[],
    bodyFontSize: number,
    metric: PageMetrics | undefined
): DocumentMetadata {
    let empty = {titleLines: [], authorLines: [], affiliationLines: [], ignoredLines: new Set<TextLine>()};
    if (!metric) {
        return empty;
    }

    let pageLines = lines.filter((line) => line.page == 1);
    let groups = titleLineGroups(pageLines, bodyFontSize, metric);
    if (groups.length == 0) {
        return empty;
    }

    let rankedTitleGroups = groups
        .sort((a, b) => {
            let fontDelta = median(b.map(lineDominantFontSize), 0) - median(a.map(lineDominantFontSize), 0);
            return fontDelta || b.reduce((sum, line) => sum + line.width, 0) - a.reduce((sum, line) => sum + line.width, 0);
        });
    let titleFontSize = median(rankedTitleGroups[0].map(lineDominantFontSize), 0);
    let tiedTitleGroups = rankedTitleGroups
        .filter((group) => Math.abs(median(group.map(lineDominantFontSize), 0) - titleFontSize) <= 0.5);
    // 同じ最大フォントの離れた行は同じタイトルとして扱い、最大が最上端のヘッダーだけなら次候補へ移る。
    let selectedTitleGroups = tiedTitleGroups;
    if (
        tiedTitleGroups.length == 1 &&
        metric.height - Math.max(...tiedTitleGroups[0].map((line) => line.y)) < bodyFontSize * 1.2
    ) {
        let lowerGroup = rankedTitleGroups.find((group) =>
            group != tiedTitleGroups[0] &&
            Math.max(...group.map((line) => line.y)) < Math.min(...tiedTitleGroups[0].map((line) => line.y)) &&
            titleFontSize - median(group.map(lineDominantFontSize), 0) <= 2.5
        );
        if (lowerGroup) {
            selectedTitleGroups = [lowerGroup];
        }
    }
    let titleLines = selectedTitleGroups
        .flat()
        .sort((a, b) => b.y - a.y || a.x - b.x);
    let titleBottom = Math.min(...titleLines.map((line) => line.y));
    let authorLines: TextLine[] = [];
    let authorStarted = false;
    let authorEnded = false;
    let authorRange = Math.max(130, bodyFontSize * 14);
    let possibleAuthors = pageLines
        .filter((line) => line.y < titleBottom - bodyFontSize * 0.4 && line.y > titleBottom - authorRange)
        .sort((a, b) => b.y - a.y || a.x - b.x);

    for (let line of possibleAuthors) {
        if (/^[\s\d•*†‡∗]+$/.test(line.text)) {
            continue;
        }
        if (looksLikeAuthorText(line.text)) {
            if (!authorEnded) {
                authorLines.push(line);
                authorStarted = true;
            }
            continue;
        }
        if (authorStarted && looksLikeAffiliationText(line.text)) {
            authorEnded = true;
        }
    }

    let affiliationLines: TextLine[] = [];
    if (authorLines.length > 0) {
        let authorTop = Math.max(...authorLines.map((line) => line.y));
        let authorBottom = Math.min(...authorLines.map((line) => line.y));
        let abstractLine = pageLines
            .filter((line) => isAbstractHeading(line.text) && line.y < authorBottom)
            .sort((a, b) => b.y - a.y)[0];
        let affiliationFloor = abstractLine
            ? abstractLine.y + bodyFontSize * 0.5
            : authorBottom - bodyFontSize * 5.5;
        affiliationLines = pageLines
            .filter((line) =>
                !authorLines.includes(line) &&
                line.y <= authorTop + LINE_Y_EPSILON &&
                line.y > affiliationFloor &&
                looksLikeAffiliationText(line.text)
            )
            .sort((a, b) => b.y - a.y || a.x - b.x);
    }

    let ignoredLines = new Set<TextLine>([...titleLines, ...authorLines, ...affiliationLines]);
    let titleTop = Math.max(...titleLines.map((line) => line.y));
    for (let line of pageLines) {
        if (
            line.y > titleTop + bodyFontSize * 1.5 ||
            line.y >= titleBottom - bodyFontSize * 0.5 &&
                line.y <= titleTop + bodyFontSize * 0.5 &&
                /^\d+(?:\.\d+)*$/.test(line.text.trim())
        ) {
            ignoredLines.add(line);
        }
    }

    return {titleLines, authorLines, affiliationLines, ignoredLines};
}

// 複数行・複数列の著者名を、誌面上の順序を保つ一つの文字列へまとめる。
function authorTextFromLines(lines: TextLine[]) {
    return lines
        .sort((a, b) => Math.abs(a.y - b.y) <= LINE_Y_EPSILON ? a.x - b.x : b.y - a.y)
        .map((line) => cleanAuthorText(line.text))
        .filter((text) => text != "")
        .join(", ");
}

// 所属・所在地・連絡先は著者の直後に一つのメタデータ段落としてまとめる。
function affiliationTextFromLines(lines: TextLine[]) {
    return lines.reduce((text, line) => appendLineText(text, line.text), "");
}

function isAbstractHeading(text: string) {
    return /^(?:ABSTRACT|Abstract)$/.test(text);
}

function isReferencesHeading(text: string) {
    return /^(?:REFERENCES|References)$/.test(text);
}

function isAcknowledgementsHeading(text: string) {
    return /^(?:ACKNOWLEDGEMENTS?|Acknowledgements?)$/.test(text);
}

function arabicSectionNumbers(text: string) {
    let match = text.match(/^(\d+(?:\.\d+)*\.?)\s+([A-Z][A-Za-z0-9 .&()/\-]+)$/);
    if (!match) {
        return null;
    }

    // 2.1 や 3.1.2 は節番号だが、2.70 GHz のような小数値は見出しではない。
    let numbers = match[1].replace(/\.$/, "").split(".").map((part) => Number(part));
    if (!numbers.every((number) => Number.isInteger(number) && number > 0 && number <= 30)) {
        return null;
    }

    return numbers;
}

function isArabicSectionHeading(text: string) {
    return arabicSectionNumbers(text) != null;
}

function isRomanSectionHeading(text: string) {
    return /^[IVX]+\.\s+[A-Z][A-Za-z0-9 .&()/\-]+$/.test(text);
}

function isLetteredSectionHeading(text: string) {
    return /^[A-Z]\.\s+[A-Z0-9][A-Za-z0-9 .&()/\-]+$/.test(text);
}

// 1., 1 Introduction, 2.1, IV., A. などの章・節番号付き見出しだけを拾う。
function isNumberedSectionHeading(text: string) {
    return (
        isArabicSectionHeading(text) ||
        isRomanSectionHeading(text) ||
        isLetteredSectionHeading(text)
    );
}

function isHeadingText(text: string) {
    return (
        isAbstractHeading(text) ||
        isReferencesHeading(text) ||
        isAcknowledgementsHeading(text) ||
        isNumberedSectionHeading(text)
    );
}

// フォントサイズと文字列パターンから見出し行を判定する。
function isHeadingLine(line: TextLine, bodyFontSize: number, relaxed = false) {
    if (isTitleLine(line, bodyFontSize)) {
        return false;
    }

    if (isAbstractHeading(line.text) || isReferencesHeading(line.text) || isAcknowledgementsHeading(line.text)) {
        return true;
    }

    let arabicNumbers = arabicSectionNumbers(line.text);
    if (arabicNumbers) {
        if (arabicNumbers.length == 1) {
            return line.fontSize >= bodyFontSize + 0.5 || /^[0-9.]+\s+[A-Z0-9 .&()/\-]+$/.test(line.text);
        }

        return line.fontSize >= bodyFontSize - 0.5 && line.text.length < 140;
    }

    if (isRomanSectionHeading(line.text) || isLetteredSectionHeading(line.text)) {
        return line.fontSize >= bodyFontSize - (relaxed ? 3.0 : 0.5) && line.text.length < 140;
    }

    return (
        line.fontSize >= bodyFontSize + 1.5 &&
        !/^\d/.test(line.text) &&
        !/[$+]/.test(line.text) &&
        /^[A-Z][A-Z0-9 .&()/\-]+$/.test(line.text)
    );
}

function headingHTMLElementName(text: string) {
    let arabicNumbers = arabicSectionNumbers(text);
    if (arabicNumbers) {
        return `h${Math.min(arabicNumbers.length + 1, 4)}`;
    }

    if (isRomanSectionHeading(text)) {
        return "h2";
    }

    if (isLetteredSectionHeading(text)) {
        return "h3";
    }

    return "h2";
}

function looksLikeHeadingContinuation(headText: string, text: string) {
    let firstWord = text.trim().split(/\s+/, 1)[0] ?? "";
    let lastHeadWord = headText.trim().split(/\s+/).pop() ?? "";
    let headEndsWithFragment = /^[A-Z]$/.test(lastHeadWord) || /\d/.test(lastHeadWord);

    return (
        /^[A-Z0-9][A-Z0-9&()/\-]*$/.test(firstWord) && firstWord.length > 1 ||
        /\b[A-Z]$/.test(headText) && /^[a-z]/.test(firstWord) ||
        headEndsWithFragment && /^[A-Z][a-z]/.test(firstWord) ||
        headEndsWithFragment && /^-/.test(firstWord) ||
        /^and\s+[A-Z0-9]/.test(text.trim())
    );
}

// OCRが同じ見出しを横方向に分割した場合、同一baseline上の短い続きとして結合する。
function isSameLineHeadingContinuation(line: TextLine, nextLine: TextLine, bodyFontSize: number) {
    let gap = nextLine.x - (line.x + line.width);
    return nextLine.page == line.page &&
        Math.abs(nextLine.y - line.y) <= LINE_Y_EPSILON &&
        gap >= -2 && gap <= Math.max(18, bodyFontSize * 2) &&
        Math.abs(nextLine.fontSize - line.fontSize) <= 1.2 &&
        nextLine.text.length <= 50 &&
        /^[A-Z][A-Za-z0-9 &()/\-]+$/.test(nextLine.text);
}

// 見出しと本文が同じ PDF 行に載っている場合に分割する。
function splitHeadingLines(lines: TextLine[], bodyFontSize: number) {
    let result: TextLine[] = [];

    for (let line of lines) {
        let splitAt = -1;
        for (let i = 1; i < line.parts.length; i++) {
            let headText = partsToText(line.parts.slice(0, i));
            let bodyText = partsToText(line.parts.slice(i));
            let part = line.parts[i];
            if (
                isHeadingText(headText) &&
                bodyText.length > 0 &&
                part.fontSize <= bodyFontSize + 0.3 &&
                !looksLikeHeadingContinuation(headText, bodyText)
            ) {
                splitAt = i;
                break;
            }
        }

        if (splitAt < 0) {
            result.push(line);
            continue;
        }

        let head = partsToLine(line.parts.slice(0, splitAt));
        let body = partsToLine(line.parts.slice(splitAt));
        if (head) {
            result.push(head);
        }
        if (body) {
            result.push(body);
        }
    }

    return result;
}

function captionStartPartIndex(line: TextLine) {
    for (let i = 0; i < line.parts.length; i++) {
        if (CAPTION_LINE_PATTERN.test(partsToText(line.parts.slice(i)))) {
            if (i == 0) {
                return i;
            }

            let prevEnd = line.parts[i - 1].x + line.parts[i - 1].width;
            let gap = line.parts[i].x - prevEnd;
            if (gap >= 8) {
                return i;
            }
        }
    }

    return -1;
}

function hasCaptionDescription(text: string) {
    return !BARE_CAPTION_LABEL_PATTERN.test(text.trim());
}

function splitCaptionTailIndex(parts: TextPart[]) {
    for (let i = 1; i < parts.length; i++) {
        let prevEnd = parts[i - 1].x + parts[i - 1].width;
        let gap = parts[i].x - prevEnd;
        let captionText = partsToText(parts.slice(0, i));
        if (gap >= 8 && captionLooksComplete(captionText) && hasCaptionDescription(captionText)) {
            return i;
        }
    }

    return parts.length;
}

// 別カラムの本文やコードと同じ baseline に載った図表キャプションを分離する。
function splitCaptionLines(lines: TextLine[]) {
    let result: TextLine[] = [];

    for (let line of lines) {
        let start = captionStartPartIndex(line);
        if (start < 0) {
            result.push(line);
            continue;
        }

        let before = partsToLine(line.parts.slice(0, start));
        let captionAndTail = line.parts.slice(start);
        let tailStart = splitCaptionTailIndex(captionAndTail);
        let caption = partsToLine(captionAndTail.slice(0, tailStart));
        let after = partsToLine(captionAndTail.slice(tailStart));

        if (before) {
            result.push(before);
        }
        if (caption) {
            result.push(caption);
        }
        if (after) {
            result.push(after);
        }
    }

    return result;
}

function dropCapPart(line: TextLine, bodyFontSize: number) {
    if (line.parts.length < 2) {
        return null;
    }

    let first = line.parts[0];
    if (!/^[A-Z]$/.test(first.text.trim())) {
        return null;
    }

    let rest = partsToLine(line.parts.slice(1));
    if (
        !rest ||
        first.fontSize < bodyFontSize * 2.2 ||
        Math.abs(lineDominantFontSize(rest) - bodyFontSize) > 1.2
    ) {
        return null;
    }

    return {dropCap: first.text.trim(), rest};
}

function normalizeDropCaps(lines: TextLine[], bodyFontSize: number) {
    let result = [...lines];

    for (let i = 0; i < result.length; i++) {
        let drop = dropCapPart(result[i], bodyFontSize);
        if (!drop) {
            continue;
        }

        let target = result
            .filter((candidate, index) =>
                index != i &&
                candidate.page == result[i].page &&
                candidate.y > result[i].y &&
                candidate.y < result[i].y + result[i].fontSize * 1.1 &&
                Math.abs(candidate.x - drop.rest.x) <= Math.max(8, bodyFontSize * 1.4) &&
                Math.abs(lineDominantFontSize(candidate) - bodyFontSize) <= 1.2
            )
            .sort((a, b) => b.y - a.y)[0];

        if (!target) {
            continue;
        }

        let targetIndex = result.indexOf(target);
        result[targetIndex] = lineWithText(target, drop.dropCap + target.text);
        result[i] = drop.rest;
    }

    return result;
}

function estimateColumnSplitX(pageLines: TextLine[]) {
    let minX = Math.min(...pageLines.map((line) => line.x));
    let maxEnd = Math.max(...pageLines.map((line) => line.x + line.width));
    let pageSpan = maxEnd - minX;
    let fallback = Math.min((minX + maxEnd) / 2, Math.max(maxEnd, 612) / 2);
    let intervals = pageLines
        .filter((line) => line.width > 40 && line.width < pageSpan * 0.65)
        .map((line) => ({x: line.x, end: line.x + line.width}))
        .sort((a, b) => a.x - b.x);

    if (intervals.length < 2) {
        return fallback;
    }

    let merged: Array<{x: number; end: number}> = [];
    for (let interval of intervals) {
        let prev = merged[merged.length - 1];
        if (!prev || interval.x > prev.end + 4) {
            merged.push({...interval});
        }
        else {
            prev.end = Math.max(prev.end, interval.end);
        }
    }

    let bestGap = 0;
    let split = fallback;
    for (let i = 0; i + 1 < merged.length; i++) {
        let gap = merged[i + 1].x - merged[i].end;
        if (gap > bestGap) {
            bestGap = gap;
            split = (merged[i].end + merged[i + 1].x) / 2;
        }
    }

    return bestGap >= 8 ? split : fallback;
}

function pageLooksTwoColumn(pageLines: TextLine[], splitX: number) {
    let leftLines = pageLines.filter((line) =>
        line.x < splitX - 20 &&
        line.x + line.width < splitX + 18 &&
        line.text.length > 20
    );
    let rightLines = pageLines.filter((line) =>
        line.x > splitX + 6 &&
        line.text.length > 20
    );

    return leftLines.length >= 3 && rightLines.length >= 3;
}

function splitMergedColumnLine(line: TextLine, splitX: number): TextLine[] {
    if (
        line.parts.length < 2 ||
        line.fontSize > 14 ||
        line.x >= splitX - 4 ||
        line.x + line.width <= splitX + 6
    ) {
        return [line];
    }

    for (let i = 1; i < line.parts.length; i++) {
        let prevEnd = line.parts[i - 1].x + line.parts[i - 1].width;
        let gap = line.parts[i].x - prevEnd;
        if (
            gap >= 8 &&
            prevEnd <= splitX + 10 &&
            line.parts[i].x >= splitX - 10
        ) {
            let before = partsToLine(line.parts.slice(0, i));
            let after = partsToLine(line.parts.slice(i));
            return [
                ...(before ? [before] : []),
                ...(after ? splitMergedColumnLine(after, splitX) : [])
            ];
        }
    }

    return [line];
}

// 同一 baseline にある左右カラムの行が PDF text item 上で近すぎる場合だけ分離する。
function splitMergedColumnLines(lines: TextLine[]) {
    let result: TextLine[] = [];
    let pages = [...new Set(lines.map((line) => line.page))].sort((a, b) => a - b);

    for (let page of pages) {
        let pageLines = lines.filter((line) => line.page == page);
        let splitX = estimateColumnSplitX(pageLines);
        if (!pageLooksTwoColumn(pageLines, splitX)) {
            result.push(...pageLines);
            continue;
        }

        for (let line of pageLines) {
            result.push(...splitMergedColumnLine(line, splitX));
        }
    }

    return result;
}

// 2 段組み論文を想定し、ページごとに左カラム、右カラムの順へ並べる。
function sortLinesForReading(lines: TextLine[]) {
    let result: TextLine[] = [];
    let pages = [...new Set(lines.map((line) => line.page))].sort((a, b) => a - b);

    for (let page of pages) {
        let pageLines = lines.filter((line) => line.page == page);
        let centerX = estimateColumnSplitX(pageLines);
        let left = pageLines.filter((line) => line.x < centerX);
        let right = pageLines.filter((line) => line.x >= centerX);
        let byY = (a: TextLine, b: TextLine) => b.y - a.y || a.x - b.x;

        result.push(...left.sort(byY), ...right.sort(byY));
    }

    return result;
}

// 行間、インデント、カラム遷移から段落の切れ目を推定する。
function shouldStartParagraph(
    line: TextLine,
    prevLine: TextLine | null,
    columnWidth: number,
    paragraph: string,
    inReferencesSection: boolean
) {
    if (!prevLine) {
        return false;
    }

    if (
        isLikelyStandaloneReferenceEntryStart(paragraph, inReferencesSection) &&
        !isReferenceEntryStart(line.text)
    ) {
        return false;
    }

    if (
        paragraph != "" &&
        isLikelyStandaloneReferenceEntryStart(line.text, inReferencesSection)
    ) {
        return true;
    }

    let paragraphIsListItem = isListItemStart(paragraph);
    let lineIsListItem = isListItemStart(line.text);
    if (paragraphIsListItem && !lineIsListItem) {
        let lineGap = prevLine.y - line.y;
        let widerThanWrappedLine = lineGap > Math.max(11.5, prevLine.fontSize * 1.25, line.fontSize * 1.25);
        // 箇条書きの後続行は深いインデントになりやすい。左端が本文側へ戻り、
        // かつ通常の折り返し行より行間が広い場合だけ、箇条書き後の段落とみなす。
        if (line.x < prevLine.x - 4 && widerThanWrappedLine) {
            return true;
        }
        return false;
    }

    if (lineIsListItem) {
        return true;
    }

    if (line.page != prevLine.page) {
        // ページをまたぐ場合は、行末と次行から継続が明確なときだけ同じ段落にする。
        return !(
            prevLine.text.endsWith("-") ||
            !paragraphEndsWithSentenceStop(paragraph) && startsLikeParagraphContinuation(line.text)
        );
    }

    let sameColumn = Math.abs(line.x - prevLine.x) < columnWidth * 0.5;
    if (!sameColumn) {
        return true;
    }

    if (prevLine.y - line.y > line.fontSize * 1.8) {
        return true;
    }

    let indented = line.x - prevLine.x > 5;
    let prevLineIsShort = prevLine.width < columnWidth * 0.82;

    return (indented || prevLineIsShort) && !prevLine.text.endsWith("-");
}

// 行末ハイフンを考慮して、連続する行テキストを 1 つの段落に連結する。
function appendLineText(base: string, next: string) {
    if (base == "") {
        return next;
    }

    if (base.endsWith("-") && /^[a-z]/.test(next)) {
        return base.slice(0, -1) + next;
    }

    return `${base} ${next}`;
}

// 句点などで明確に文が終わっていれば、図表の前後を同じ段落として結合しない。
function paragraphEndsWithSentenceStop(text: string) {
    return /[.!?)]["']*$/.test(text.trim());
}

// 図表・観察項目・章節見出しらしい始まりは、新しいブロックとして扱う。
function startsLikeNewBlock(text: string) {
    let trimmed = text.trim();
    return (
        /^(?:Figure|Fig\.|Table|Algorithm)\s+/i.test(trimmed) ||
        /^Observation-\d+/.test(trimmed) ||
        isListItemStart(trimmed) ||
        /^(?:[A-Z]|[IVX]+)\.\s+/.test(trimmed)
    );
}

function isListItemStart(text: string) {
    return /^(?:[•‣❯]|\d+[.)])\s+/.test(text.trim());
}

function isReferenceEntryStart(text: string) {
    return /^(?:\[\d+\]|\d+\.)\s+/.test(text.trim());
}

// REFERENCES 見出しを抽出できない文書でも文献を分離するが、本文冒頭の [21] selectively... のような継続は除く。
function isLikelyStandaloneReferenceEntryStart(text: string, inReferencesSection: boolean) {
    if (!isReferenceEntryStart(text)) {
        return false;
    }

    let remainder = text.trim().replace(/^(?:\[\d+\]|\d+\.)\s+/, "");
    return inReferencesSection || !/^[a-z]/.test(remainder);
}

// 図中の目盛りやベンチマーク名の列は数字・記号・短い識別子から始まりやすい。
// これを段落継続の根拠にすると、図の内側の文字が本文へ混ざるため除外する。
function startsLikeNonProseFragment(text: string) {
    let trimmed = text.trim();
    if (/^\d+(?:\s+(?:\d|1E[+-]?\d+)){3,}/i.test(trimmed)) {
        return true;
    }

    let tokens = trimmed.split(/\s+/).slice(0, 8);
    let labelLikeTokens = tokens.filter((token) =>
        /[_.]|\d/.test(token) &&
        !/^\(?\d+(?:[.,]\d+)?%?\)?$/.test(token)
    ).length;
    let proseTokens = tokens.filter((token) => /[a-z]{3,}/i.test(token)).length;

    return tokens.length >= 4 && labelLikeTokens >= 3 && proseTokens <= 2;
}

// 小文字や数字で始まる十分な長さのテキストは、直前の文の続きである可能性が高い。
// 1 文字程度の断片は図中ラベル由来のことがあるため、継続根拠にはしない。
function startsLikeParagraphContinuation(text: string) {
    let trimmed = text.trim();
    if (trimmed.length <= 2 || startsLikeNonProseFragment(trimmed)) {
        return false;
    }

    if (/^[("']?\s*\d/.test(trimmed)) {
        return /[a-z]{3,}/i.test(trimmed);
    }

    return /^[("']?\s*[a-z]/.test(trimmed);
}

// 前半が前置詞や接続詞などで終わる場合、次のテキストを同じ文の続きとみなしやすい。
function endsWithOpenPhrase(text: string) {
    return /(?:[-,;:]|\b(?:and|or|of|the|a|an|to|in|on|for|with|without|by|from|as|than|that|which|when|where|while|because|using|between|into|across|only|most|all))$/i.test(text.trim());
}

// 数式断片で終わる段落は、通常の句点終端よりも次行との結合を優先する。
function endsWithFormulaFragment(text: string) {
    return /(?:\(\s*\)|[∑⌊⌋∼=+\-*/,:;]|\b(?:at|of|to|is|are|where|which|when|therefore))$/i.test(text.trim());
}

// 数式行の一部は句読点や括弧から始まるため、通常の小文字開始とは別に扱う。
function startsLikeFormulaContinuation(text: string) {
    return /^[("']?\s*(?:[a-z]|\(|;|,|∑|⌊|O\b|log\b)/.test(text.trim());
}

function startsLikeSentenceStart(text: string) {
    return /^[("']?\s*[A-Z]/.test(text.trim());
}

function isUppercaseCaptionContinuation(text: string) {
    let trimmed = text.trim();
    return /[A-Z]{2,}/.test(trimmed) &&
        !/[a-z]/.test(trimmed) &&
        /^[A-Z0-9 .,&()/§\-]+$/.test(trimmed);
}

function isTightCaptionBlockContinuation(
    captionLine: TextLine,
    prevLine: TextLine,
    nextLine: TextLine,
    bodyFontSize: number
) {
    if (nextLine.page != captionLine.page || nextLine.y >= prevLine.y) {
        return false;
    }

    let xTolerance = Math.max(6, bodyFontSize * 0.8);
    let sameLeftEdge =
        Math.abs(nextLine.x - captionLine.x) <= xTolerance ||
        Math.abs(nextLine.x - prevLine.x) <= xTolerance;
    let gap = prevLine.y - nextLine.y;
    let tightLineGap = gap > 0 && gap <= Math.max(12, bodyFontSize * 1.25, captionLine.fontSize * 1.45);
    let compatibleFont =
        Math.abs(nextLine.fontSize - prevLine.fontSize) <= 0.8 &&
        nextLine.fontSize <= captionLine.fontSize + 1.0;

    return sameLeftEdge && tightLineGap && compatibleFont;
}

function isOpenTableCaptionContinuation(
    caption: string,
    captionLine: TextLine,
    prevLine: TextLine,
    nextLine: TextLine,
    bodyFontSize: number,
    columnWidth: number
) {
    let trimmed = nextLine.text.trim();
    if (
        captionLooksComplete(caption) ||
        trimmed.length < 10 ||
        startsLikeNewBlock(trimmed) ||
        !isTightCaptionBlockContinuation(captionLine, prevLine, nextLine, bodyFontSize)
    ) {
        return false;
    }

    let proseLike =
        /[a-z]{3,}/i.test(trimmed) &&
        /\s/.test(trimmed) &&
        nextLine.width >= Math.min(90, columnWidth * 0.3);
    return proseLike && (
        startsLikeParagraphContinuation(trimmed) ||
        /[.!?)]/.test(trimmed)
    );
}

function isWrappedCaptionContinuation(
    caption: string,
    captionLine: TextLine,
    prevLine: TextLine,
    nextLine: TextLine,
    bodyFontSize: number,
    columnWidth: number
) {
    if (
        nextLine.page != captionLine.page ||
        isLetteredSectionHeading(nextLine.text) ||
        startsLikeNewBlock(nextLine.text) ||
        !isTightCaptionBlockContinuation(captionLine, prevLine, nextLine, bodyFontSize)
    ) {
        return false;
    }

    let trimmed = nextLine.text.trim();
    if (
        !captionLooksComplete(caption) ||
        prevLine.text.endsWith("-") ||
        endsWithOpenPhrase(caption) ||
        startsLikeParagraphContinuation(trimmed)
    ) {
        return true;
    }

    let sameLeftEdge = Math.abs(nextLine.x - captionLine.x) <= Math.max(6, bodyFontSize * 0.8);
    let captionBlockWidth = Math.max(captionLine.width * 1.05, columnWidth * 1.05);
    return sameLeftEdge &&
        captionLine.text.length > 40 &&
        nextLine.width > columnWidth * 0.55 &&
        nextLine.width <= captionBlockWidth;
}

// 図表を挟んだ前後の TEXT ノードが、同じ段落から分断されたものかを保守的に判定する。
function looksLikeInterruptedParagraph(before: string, after: string) {
    if (before.trim() == "" || after.trim() == "" || startsLikeNewBlock(after)) {
        return false;
    }

    if (startsLikeNonProseFragment(after)) {
        return false;
    }

    if (before.trim().endsWith("-")) {
        return true;
    }

    if (paragraphEndsWithSentenceStop(before) && !endsWithFormulaFragment(before)) {
        return false;
    }

    let startsLikeContinuation =
        startsLikeParagraphContinuation(after) ||
        startsLikeFormulaContinuation(after);

    return (
        startsLikeContinuation ||
        (endsWithFormulaFragment(before) || endsWithOpenPhrase(before)) &&
            !startsLikeSentenceStart(after)
    );
}

// 図表が段落の途中に挿入された場合、本文を結合して図表を段落の直後へ寄せる。
function moveInterruptedFiguresAfterParagraphs(nodes: PDF_Node[]) {
    let result: PDF_Node[] = [];

    for (let i = 0; i < nodes.length; i++) {
        let node = nodes[i];
        if (node.type != PDF_NodeType.TEXT) {
            result.push(node);
            continue;
        }

        let text = node.str;
        let delayedFigures: PDF_Node[] = [];
        let cursor = i;

        while (true) {
            // TEXT の直後に連続する FIGURE 群を探し、その次が続きの TEXT なら本文を先に結合する。
            let figureStart = cursor + 1;
            let nextTextIndex = figureStart;
            while (nodes[nextTextIndex]?.type == PDF_NodeType.FIGURE) {
                nextTextIndex++;
            }

            let figures = nodes.slice(figureStart, nextTextIndex);
            let nextText = nodes[nextTextIndex];
            if (
                figures.length == 0 ||
                !nextText ||
                nextText.type != PDF_NodeType.TEXT ||
                (node.sourceRect?.page != nextText.sourceRect?.page && !text.trim().endsWith("-")) ||
                !looksLikeInterruptedParagraph(text, nextText.str)
            ) {
                break;
            }

            text = appendLineText(text, nextText.str);
            delayedFigures.push(...figures);
            cursor = nextTextIndex;
        }

        // 図表を後ろへ寄せたことで、続けて隣接した TEXT も同じ段落ならまとめる。
        while (
            delayedFigures.length > 0 &&
            nodes[cursor + 1]?.type == PDF_NodeType.TEXT &&
            looksLikeInterruptedParagraph(text, nodes[cursor + 1].str)
        ) {
            text = appendLineText(text, nodes[cursor + 1].str);
            cursor++;
        }

        result.push(new PDF_Node(text, PDF_NodeType.TEXT, undefined, node.sourceRect), ...delayedFigures);
        i = cursor;
    }

    return result;
}

// 図をまたがない場合でも、数式断片などで隣接 TEXT に割れた本文は最後にまとめ直す。
function mergeAdjacentTextFragments(nodes: PDF_Node[], columnWidth: number) {
    let result: PDF_Node[] = [];

    for (let node of nodes) {
        let prev = result[result.length - 1];
        if (
            prev?.type == PDF_NodeType.TEXT &&
            node.type == PDF_NodeType.TEXT &&
            prev.sourceRect?.page == node.sourceRect?.page &&
            !(
                !prev.str.trim().endsWith("-") &&
                prev.str.length < 40 &&
                (prev.sourceRect?.width ?? columnWidth) < columnWidth * 0.5
            ) &&
            looksLikeInterruptedParagraph(prev.str, node.str)
        ) {
            prev.str = appendLineText(prev.str, node.str);
        }
        else {
            result.push(node);
        }
    }

    return result;
}

function captionLooksComplete(caption: string) {
    return /[.!?)]$/.test(caption);
}

function clamp(value: number, minValue: number, maxValue: number) {
    return Math.max(minValue, Math.min(value, maxValue));
}

function rectRight(rect: PDF_Rect) {
    return rect.x + rect.width;
}

function rectTop(rect: PDF_Rect) {
    return rect.y + rect.height;
}

function rectArea(rect: PDF_Rect) {
    return rect.width * rect.height;
}

function rectsOverlap(a: PDF_Rect, b: PDF_Rect, margin = 0) {
    return (
        a.page == b.page &&
        rectRight(a) + margin >= b.x &&
        rectRight(b) + margin >= a.x &&
        rectTop(a) + margin >= b.y &&
        rectTop(b) + margin >= a.y
    );
}

function rectContainsRect(outer: PDF_Rect, inner: PDF_Rect, margin = 0) {
    return outer.page == inner.page &&
        inner.x >= outer.x - margin &&
        rectRight(inner) <= rectRight(outer) + margin &&
        inner.y >= outer.y - margin &&
        rectTop(inner) <= rectTop(outer) + margin;
}

function intersectRectsLoose(a: PDF_Rect, b: PDF_Rect) {
    if (a.page != b.page) {
        return null;
    }

    let x = Math.max(a.x, b.x);
    let y = Math.max(a.y, b.y);
    let right = Math.min(rectRight(a), rectRight(b));
    let top = Math.min(rectTop(a), rectTop(b));
    if (right <= x || top <= y) {
        return null;
    }

    return {page: a.page, x, y, width: right - x, height: top - y};
}

function expandRect(rect: PDF_Rect, margin: number, metric: PageMetrics): PDF_Rect {
    let x = clamp(rect.x - margin, 0, metric.width);
    let y = clamp(rect.y - margin, 0, metric.height);
    let right = clamp(rectRight(rect) + margin, x, metric.width);
    let top = clamp(rectTop(rect) + margin, y, metric.height);
    return {...rect, x, y, width: right - x, height: top - y};
}

function isParagraphLikeLine(line: TextLine, bodyFontSize: number, columnWidth: number) {
    return (
        Math.abs(line.fontSize - bodyFontSize) < 1.0 &&
        line.width > columnWidth * 0.85 &&
        line.text.length > 55
    );
}

function bodyLayoutSeedLine(line: TextLine, bodyFontSize: number, columnWidth: number) {
    return Math.abs(line.fontSize - bodyFontSize) < 0.8 &&
        line.width > columnWidth * 0.55 &&
        line.text.length > 30 &&
        !isCaptionLine(line, bodyFontSize, columnWidth) &&
        !isHeadingLine(line, bodyFontSize) &&
        !isTitleLine(line, bodyFontSize);
}

// 本文は同じカラム内で左端と baseline 間隔が安定しているため、その規則性をページごとに推定する。
function estimateBodyLayout(lines: TextLine[], bodyFontSize: number, columnWidth: number): BodyLayoutModel {
    let columns: BodyColumnModel[] = [];
    let pages = new Set(lines.map((line) => line.page));

    for (let page of pages) {
        let buckets: Array<{xs: number[]; ys: number[]}> = [];
        let seeds = lines
            .filter((line) => line.page == page && bodyLayoutSeedLine(line, bodyFontSize, columnWidth))
            .sort((a, b) => a.x - b.x);

        for (let line of seeds) {
            let bucket = buckets.find((candidate) =>
                Math.abs(line.x - median(candidate.xs, line.x)) <= 18
            );
            if (!bucket) {
                buckets.push({xs: [line.x], ys: [line.y]});
                continue;
            }

            bucket.xs.push(line.x);
            bucket.ys.push(line.y);
        }

        for (let bucket of buckets) {
            if (bucket.ys.length < 3) {
                continue;
            }

            let ys = [...bucket.ys].sort((a, b) => b - a);
            let diffs: number[] = [];
            for (let i = 0; i + 1 < ys.length; i++) {
                let diff = ys[i] - ys[i + 1];
                if (diff >= bodyFontSize * 0.7 && diff <= bodyFontSize * 2.4) {
                    diffs.push(diff);
                }
            }

            columns.push({
                page,
                x: median(bucket.xs, bucket.xs[0]),
                yStep: median(diffs, bodyFontSize * 1.25),
                baselines: ys
            });
        }
    }

    return {columns};
}

function looksLikeBodyLine(line: TextLine, bodyFontSize: number) {
    return (
        line.fontSize >= bodyFontSize - 1.2 ||
        isCaptionLine(line) ||
        isHeadingLine(line, bodyFontSize)
    );
}

function lineHorizontallyRelated(a: TextLine, b: TextLine, columnWidth: number) {
    let aRight = a.x + a.width;
    let bRight = b.x + b.width;
    let overlap = Math.min(aRight, bRight) - Math.max(a.x, b.x);

    return overlap > -columnWidth * 0.2 || Math.abs(a.x - b.x) < columnWidth * 0.65;
}

// インライン数式の上付き・下付きは小さい行として抽出されることがある。
// 近くに本文サイズの行があれば、行自体は捨てても段落継続状態は保つ。
function nearBodyLine(
    line: TextLine,
    other: TextLine | null | undefined,
    bodyFontSize: number,
    columnWidth: number
) {
    return (
        other != null &&
        other.page == line.page &&
        Math.abs(other.y - line.y) < bodyFontSize * 1.8 &&
        lineHorizontallyRelated(line, other, columnWidth) &&
        looksLikeBodyLine(other, bodyFontSize)
    );
}

function isPullQuoteLine(line: TextLine, bodyFontSize: number) {
    let text = line.text.trim();
    if (isHeadingText(text)) {
        return false;
    }

    return text.length >= 10 &&
        text.split(/\s+/).length >= 2 &&
        Math.abs(lineDominantFontSize(line) - bodyFontSize) <= 1.5 &&
        /[A-Z]{2,}/.test(text) &&
        !/[a-z]/.test(text) &&
        /^[A-Z0-9 .,&()/§\-]+$/.test(text);
}

// キャプション継続行は、キャプション先頭と近いフォント・近い位置に出ることが多い。
// 本文段落や節見出しらしい行に入ったら、キャプションの過剰連結を避けるため止める。
function isLikelyCaptionContinuationLine(
    captionLine: TextLine,
    prevLine: TextLine,
    nextLine: TextLine,
    bodyFontSize: number,
    columnWidth: number
) {
    if (nextLine.page != captionLine.page) {
        return false;
    }

    if (isLetteredSectionHeading(nextLine.text)) {
        return false;
    }

    let sameColumn = Math.abs(nextLine.x - captionLine.x) < columnWidth * 0.6;
    let closeLineGap = Math.abs(prevLine.y - nextLine.y) <= Math.max(bodyFontSize * 1.8, captionLine.fontSize * 2.2);
    let compatibleFont = nextLine.fontSize <= captionLine.fontSize + 0.8;

    if (prevLine.text.endsWith("-")) {
        return sameColumn && closeLineGap && compatibleFont;
    }

    if (
        nextLine.fontSize >= bodyFontSize - 0.2 &&
        isParagraphLikeLine(nextLine, bodyFontSize, columnWidth)
    ) {
        return false;
    }

    return sameColumn && closeLineGap && compatibleFont;
}

function usefulGraphicObject(graphic: PDF_GraphicObject, metric: PageMetrics) {
    if (graphic.width <= 0 || graphic.height <= 0) {
        return false;
    }

    // ページ全体のクリップ枠や背景に近いものは、図そのものではなく描画補助とみなす。
    if (graphic.width > metric.width * 0.95 && graphic.height > metric.height * 0.6) {
        return false;
    }

    if (graphic.kind == "image" || graphic.kind == "form") {
        return rectArea(graphic) >= 16;
    }

    return rectArea(graphic) >= 6 || Math.max(graphic.width, graphic.height) >= 10;
}

// ページ全面が1枚の画像で、その上にOCRテキストだけが重なっているPDFかを判定する。
function hasFullPageImage(graphics: PDF_GraphicObject[], metric: PageMetrics) {
    return graphics.some((graphic) =>
        graphic.page == metric.page &&
        graphic.kind == "image" &&
        graphic.width >= metric.width * 0.9 &&
        graphic.height >= metric.height * 0.9
    );
}

function lineRect(line: TextLine): PDF_Rect {
    return {
        page: line.page,
        x: line.x,
        y: line.y - line.fontSize * 0.25,
        width: line.width,
        height: line.fontSize * 1.25
    };
}

function isBodySizedProseFragment(line: TextLine, bodyFontSize: number) {
    return line.fontSize >= Math.max(7, bodyFontSize - 0.8) &&
        line.text.length > 12 &&
        /[a-z]{3,}/i.test(line.text) &&
        /\s/.test(line.text);
}

function matchesBodyColumnX(line: TextLine, column: BodyColumnModel, columnWidth: number) {
    let delta = line.x - column.x;
    return Math.abs(delta) <= 8 ||
        delta > 0 && delta <= 24 && line.width > columnWidth * 0.35;
}

function matchesBodyBaseline(line: TextLine, column: BodyColumnModel) {
    let tolerance = Math.max(2.5, column.yStep * 0.22);
    return column.baselines.some((baseline) => {
        let diff = Math.abs(line.y - baseline);
        return diff <= tolerance ||
            Math.abs(diff - column.yStep) <= tolerance ||
            Math.abs(diff - column.yStep * 2) <= tolerance;
    });
}

function isBodyLayoutLine(
    line: TextLine,
    bodyLayout: BodyLayoutModel | undefined,
    bodyFontSize: number,
    columnWidth: number
) {
    if (!bodyLayout || line.fontSize < bodyFontSize - 1.2 || line.fontSize > bodyFontSize + 1.2) {
        return false;
    }

    if (!isBodySizedProseFragment(line, bodyFontSize) && line.text.length < 18) {
        return false;
    }

    return bodyLayout.columns.some((column) =>
        column.page == line.page &&
        matchesBodyColumnX(line, column, columnWidth) &&
        matchesBodyBaseline(line, column)
    );
}

function lineNearGraphics(line: TextLine, graphics: PDF_GraphicObject[], metric: PageMetrics) {
    let box = expandRect(lineRect(line), 6, metric);
    return graphics.some((graphic) =>
        graphic.page == line.page &&
        usefulGraphicObject(graphic, metric) &&
        rectsOverlap(box, expandRect(graphic, Math.max(4, graphic.strokeWidth ?? 1), metric))
    );
}

function isAlgorithmCodeLine(line: TextLine) {
    let text = line.text.trim();
    return /^\d+\s+\S/.test(text) ||
        /^(?:Input:|Output:|Function\b|foreach\b|if\b|return\b|continue\b)/.test(text) ||
        /^(?:[A-Za-z_]\w*|[A-Z])\s*←/.test(text);
}

function graphicExcludedByCaption(graphic: PDF_GraphicObject, captionLines: TextLine[], metric: PageMetrics) {
    if (graphic.kind != "path") {
        return false;
    }

    let graphicBox = expandRect(graphic, Math.max(2, graphic.strokeWidth ?? 1), metric);
    return captionLines.some((line) => {
        let captionBox = lineRect(line);
        return rectsOverlap(graphicBox, captionBox, 1) ||
            rectContainsRect(graphicBox, captionBox, 2);
    });
}

function excludedCaptionGraphics(graphics: PDF_GraphicObject[], figures: FigureCandidate[], metric: PageMetrics) {
    let captionLines = figures
        .flatMap((figure) => figure.captionLines)
        .filter((line) => line.page == metric.page);

    if (captionLines.length == 0) {
        return [];
    }

    return graphics.filter((graphic) =>
        graphic.page == metric.page &&
        usefulGraphicObject(graphic, metric) &&
        graphicExcludedByCaption(graphic, captionLines, metric)
    );
}

function createOccupancyMask(rect: PDF_Rect, cellSize = OCCUPANCY_CELL_SIZE): OccupancyMask {
    return {
        page: rect.page,
        x: rect.x,
        y: rect.y,
        width: Math.max(1, Math.ceil(rect.width / cellSize)),
        height: Math.max(1, Math.ceil(rect.height / cellSize)),
        cellSize,
        cells: new Uint8Array(
            Math.max(1, Math.ceil(rect.width / cellSize)) *
            Math.max(1, Math.ceil(rect.height / cellSize))
        ),
        debugLineCount: 0,
        debugGraphicCount: 0
    };
}

function maskRectRange(mask: OccupancyMask, rect: PDF_Rect) {
    if (rect.page != mask.page) {
        return null;
    }

    let left = Math.max(rect.x, mask.x);
    let right = Math.min(rectRight(rect), mask.x + mask.width * mask.cellSize);
    let bottom = Math.max(rect.y, mask.y);
    let top = Math.min(rectTop(rect), mask.y + mask.height * mask.cellSize);
    if (right <= left || top <= bottom) {
        return null;
    }

    let x0 = clamp(Math.floor((left - mask.x) / mask.cellSize), 0, mask.width);
    let x1 = clamp(Math.ceil((right - mask.x) / mask.cellSize), x0, mask.width);
    let y0 = clamp(Math.floor((bottom - mask.y) / mask.cellSize), 0, mask.height);
    let y1 = clamp(Math.ceil((top - mask.y) / mask.cellSize), y0, mask.height);
    if (x1 <= x0 || y1 <= y0) {
        return null;
    }

    return {x0, x1, y0, y1};
}

function drawRectToMask(mask: OccupancyMask, rect: PDF_Rect, bits: number) {
    let range = maskRectRange(mask, rect);
    if (!range) {
        return;
    }

    for (let y = range.y0; y < range.y1; y++) {
        let offset = y * mask.width;
        for (let x = range.x0; x < range.x1; x++) {
            mask.cells[offset + x] |= bits;
        }
    }
}

function drawRectOutlineToMask(mask: OccupancyMask, rect: PDF_Rect, bits: number) {
    let t = mask.cellSize * 2;
    drawRectToMask(mask, {page: rect.page, x: rect.x, y: rect.y, width: rect.width, height: t}, bits);
    drawRectToMask(mask, {page: rect.page, x: rect.x, y: rectTop(rect) - t, width: rect.width, height: t}, bits);
    drawRectToMask(mask, {page: rect.page, x: rect.x, y: rect.y, width: t, height: rect.height}, bits);
    drawRectToMask(mask, {page: rect.page, x: rectRight(rect) - t, y: rect.y, width: t, height: rect.height}, bits);
}

function lineOccupancyBits(
    line: TextLine,
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    bodyLayout?: BodyLayoutModel
) {
    if (isCaptionLine(line, bodyFontSize, columnWidth) || isAlgorithmCaptionLine(line)) {
        return MASK_CAPTION;
    }
    if (isHeadingText(line.text)) {
        return MASK_HEADING;
    }
    if (isBodyLayoutLine(line, bodyLayout, bodyFontSize, columnWidth)) {
        return MASK_BODY;
    }
    if (
        isParagraphLikeLine(line, bodyFontSize, columnWidth) ||
        isBodySizedProseFragment(line, bodyFontSize) ||
        isBodyTextForOccupancyMask(line, bodyFontSize, columnWidth)
    ) {
        return MASK_BODY;
    }
    if (
        line.fontSize < bodyFontSize - 0.8 ||
        line.width < columnWidth * 0.7 ||
        lineNearGraphics(line, graphics, metric)
    ) {
        return MASK_FLOAT_TEXT;
    }
    return MASK_OTHER_TEXT;
}

function isBodyTextForOccupancyMask(line: TextLine, bodyFontSize: number, columnWidth: number) {
    return Math.abs(line.fontSize - bodyFontSize) <= 1.2 &&
        line.width > Math.min(90, columnWidth * 0.32) &&
        line.text.length > 14 &&
        /[a-z]{3,}/i.test(line.text) &&
        /\s/.test(line.text);
}

function paintOccupancyMask(
    mask: OccupancyMask,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    bodyLayout?: BodyLayoutModel
) {
    for (let graphic of graphics) {
        if (graphic.page == mask.page && usefulGraphicObject(graphic, metric)) {
            mask.debugGraphicCount++;
            drawRectToMask(mask, expandRect(graphic, Math.max(1, graphic.strokeWidth ?? 1), metric), MASK_SHAPE);
        }
    }

    for (let line of lines) {
        if (line.page == mask.page) {
            mask.debugLineCount++;
            drawRectToMask(
                mask,
                lineRect(line),
                lineOccupancyBits(line, graphics, bodyFontSize, columnWidth, metric, bodyLayout)
            );
        }
    }
}

function buildOccupancyMask(
    rect: PDF_Rect,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    bodyLayout?: BodyLayoutModel
) {
    let mask = createOccupancyMask(rect);
    paintOccupancyMask(mask, lines, graphics, bodyFontSize, columnWidth, metric, bodyLayout);
    return mask;
}

function fmtRect(rect: PDF_Rect | null) {
    if (!rect) {
        return "null";
    }
    return `p${rect.page} x=${rect.x.toFixed(1)} y=${rect.y.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)}`;
}

function maskRangeToRect(mask: OccupancyMask, range: MaskRange): PDF_Rect {
    return {
        page: mask.page,
        x: mask.x + range.x0 * mask.cellSize,
        y: mask.y + range.y0 * mask.cellSize,
        width: Math.max(mask.cellSize, (range.x1 - range.x0) * mask.cellSize),
        height: Math.max(mask.cellSize, (range.y1 - range.y0) * mask.cellSize)
    };
}

function scanLoggerForCaption(options: PDF_ExtractOptions | undefined, caption: string): DebugScanLog | undefined {
    if (!options?.debugScanSink) {
        return undefined;
    }

    let needle = options.debugScanCaption?.trim();
    if (needle && !caption.includes(needle)) {
        return undefined;
    }

    return (message) => options.debugScanSink?.(`[scan] ${message}`);
}

function colorToSVG(color: [number, number, number]) {
    return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function appendMaskLayerSVG(
    svg: string[],
    mask: OccupancyMask,
    bit: number,
    color: [number, number, number],
    opacity: number
) {
    svg.push(`<g fill="${colorToSVG(color)}" fill-opacity="${opacity}">`);

    for (let y = 0; y < mask.height; y++) {
        let runStart = -1;
        for (let x = 0; x < mask.width; x++) {
            let visible = (mask.cells[y * mask.width + x] & bit) != 0;
            if (!visible) {
                if (runStart >= 0) {
                    svg.push(`<rect x="${mask.x + runStart * mask.cellSize}" y="${mask.y + y * mask.cellSize}" width="${(x - runStart) * mask.cellSize}" height="${mask.cellSize}"/>`);
                    runStart = -1;
                }
                continue;
            }
            if (runStart < 0) {
                runStart = x;
            }
        }
        if (runStart >= 0) {
            svg.push(`<rect x="${mask.x + runStart * mask.cellSize}" y="${mask.y + y * mask.cellSize}" width="${(mask.width - runStart) * mask.cellSize}" height="${mask.cellSize}"/>`);
        }
    }

    svg.push(`</g>`);
}

function appendBBoxLayerSVG(
    svg: string[],
    rects: PDF_Rect[],
    stroke: [number, number, number],
    opacity: number,
    strokeWidth: number,
    dash = ""
) {
    let dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    svg.push(`<g fill="none" stroke="${colorToSVG(stroke)}" stroke-opacity="${opacity}" stroke-width="${strokeWidth}"${dashAttr}>`);
    for (let rect of rects) {
        svg.push(`<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"/>`);
    }
    svg.push(`</g>`);
}

function lineRectsByMaskBit(
    lines: TextLine[],
    bit: number,
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    bodyLayout: BodyLayoutModel
) {
    return lines
        .filter((line) =>
            line.page == metric.page &&
            (lineOccupancyBits(line, graphics, bodyFontSize, columnWidth, metric, bodyLayout) & bit) != 0
        )
        .map(lineRect);
}

function isOuterFrameLikeGraphic(graphic: PDF_GraphicObject, metric: PageMetrics) {
    return graphic.width > metric.width * 0.45 &&
        graphic.height > metric.height * 0.35 &&
        graphic.x >= -metric.width * 0.05 &&
        graphic.y >= -metric.height * 0.05 &&
        rectRight(graphic) <= metric.width * 1.05 &&
        rectTop(graphic) <= metric.height * 1.05;
}

function occupancyMaskToSVG(
    mask: OccupancyMask,
    metric: PageMetrics,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    figures: FigureCandidate[],
    bodyFontSize: number,
    columnWidth: number,
    bodyLayout: BodyLayoutModel
): PDF_DebugMaskDump {
    let pageWidth = mask.width * mask.cellSize;
    let pageHeight = mask.height * mask.cellSize;
    let flipY = mask.y * 2 + pageHeight;
    let occupiedCells = mask.cells.reduce((count, bits) => count + (bits == 0 ? 0 : 1), 0);
    let pageLines = lines.filter((line) => line.page == mask.page);
    let pageGraphics = graphics.filter((graphic) => graphic.page == mask.page && usefulGraphicObject(graphic, metric));
    let pageExcludedGraphics = excludedCaptionGraphics(graphics, figures, metric);
    let pageExcludedOuterFrames = pageExcludedGraphics.filter((graphic) => isOuterFrameLikeGraphic(graphic, metric));
    let pageAnchorGraphics = pageGraphics.filter((graphic) => !pageExcludedGraphics.includes(graphic));
    let pageFigures = figures
        .map((figure) => figure.node.rect)
        .filter((rect): rect is PDF_Rect => rect?.page == mask.page);
    let svg: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}" height="${pageHeight}" viewBox="${mask.x} ${mask.y} ${pageWidth} ${pageHeight}">`,
        `<!-- page=${mask.page} lines=${mask.debugLineCount} graphics=${mask.debugGraphicCount} crops=${pageFigures.length} occupiedCells=${occupiedCells} -->`,
        `<rect x="${mask.x}" y="${mask.y}" width="${pageWidth}" height="${pageHeight}" fill="white"/>`,
        `<g transform="translate(0 ${flipY}) scale(1 -1)" shape-rendering="crispEdges">`
    ];

    // 1 セルに複数属性が立つので、単一色へ潰さず半透明レイヤとして重ねて表示する。
    appendMaskLayerSVG(svg, mask, MASK_SHAPE, [40, 105, 220], 0.28);
    appendMaskLayerSVG(svg, mask, MASK_OTHER_TEXT, [210, 210, 210], 0.6);
    appendMaskLayerSVG(svg, mask, MASK_BODY, [80, 80, 80], 0.7);
    appendMaskLayerSVG(svg, mask, MASK_BODY_LAYOUT, [0, 0, 0], 0.55);
    appendMaskLayerSVG(svg, mask, MASK_FLOAT_TEXT, [40, 160, 80], 0.55);
    appendMaskLayerSVG(svg, mask, MASK_CAPTION, [220, 55, 45], 0.78);
    appendMaskLayerSVG(svg, mask, MASK_HEADING, [155, 80, 185], 0.78);
    appendMaskLayerSVG(svg, mask, MASK_CROP, [255, 200, 0], 0.9);

    // 細い枠線は bitmap 化前の元 bbox。大きな mask が元 bbox 由来か、塗りの連結かを確認する。
    appendBBoxLayerSVG(svg, pageAnchorGraphics, [0, 80, 220], 0.95, 0.8, "3 2");
    appendBBoxLayerSVG(svg, pageExcludedOuterFrames, [230, 40, 160], 1.0, 1.4, "6 2");
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_OTHER_TEXT, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [150, 150, 150], 0.8, 0.5);
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_BODY, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [20, 20, 20], 0.9, 0.5);
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_BODY_LAYOUT, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [0, 0, 0], 1.0, 0.9);
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_FLOAT_TEXT, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [0, 125, 55], 0.9, 0.5);
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_CAPTION, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [200, 20, 20], 0.95, 0.7);
    appendBBoxLayerSVG(svg, lineRectsByMaskBit(pageLines, MASK_HEADING, graphics, bodyFontSize, columnWidth, metric, bodyLayout), [120, 45, 170], 0.95, 0.7);
    appendBBoxLayerSVG(svg, pageFigures, [220, 160, 0], 1.0, 1.5);

    svg.push(`</g>`);
    svg.push(`<g font-family="sans-serif" font-size="10">`);
    svg.push(`<rect x="${mask.x + 6}" y="${mask.y + 6}" width="230" height="178" fill="white" fill-opacity="0.86" stroke="#ddd"/>`);
    [
        ["MASK_SHAPE", [40, 105, 220]],
        ["MASK_OTHER_TEXT", [210, 210, 210]],
        ["MASK_BODY", [80, 80, 80]],
        ["MASK_BODY_LAYOUT", [0, 0, 0]],
        ["MASK_FLOAT_TEXT", [40, 160, 80]],
        ["MASK_CAPTION", [220, 55, 45]],
        ["MASK_HEADING", [155, 80, 185]],
        ["MASK_CROP", [255, 200, 0]],
        ["BBOX_SHAPE", [0, 80, 220]],
        ["BBOX_EXCLUDED_OUTER_FRAME", [230, 40, 160]],
        ["BBOX_TEXT", [20, 20, 20]],
        ["BBOX_CROP", [220, 160, 0]]
    ].forEach(([label, color], i) => {
        let y = mask.y + 18 + i * 14;
        svg.push(`<rect x="${mask.x + 14}" y="${y - 8}" width="10" height="10" fill="${colorToSVG(color as [number, number, number])}"/>`);
        svg.push(`<text x="${mask.x + 30}" y="${y}">${label}</text>`);
    });
    svg.push(`</g>`);
    svg.push(`</svg>`);

    return {
        page: mask.page,
        width: mask.width,
        height: mask.height,
        cellSize: mask.cellSize,
        svg: `${svg.join("\n")}\n`
    };
}

function emitDebugMasks(
    options: PDF_ExtractOptions | undefined,
    pageMetrics: Map<number, PageMetrics>,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    figures: FigureCandidate[],
    bodyFontSize: number,
    columnWidth: number,
    bodyLayout: BodyLayoutModel,
    masks: Map<number, OccupancyMask>
) {
    if (!options?.debugMaskSink) {
        return;
    }

    for (let metric of pageMetrics.values()) {
        let original = masks.get(metric.page);
        if (!original) continue;
        let mask = {...original, cells: original.cells.slice()};
        for (let figure of figures) {
            if (figure.node.rect?.page == metric.page) {
                drawRectOutlineToMask(mask, figure.node.rect, MASK_CROP);
            }
        }
        options.debugMaskSink(occupancyMaskToSVG(mask, metric, lines, graphics, figures, bodyFontSize, columnWidth, bodyLayout));
    }
}

// Algorithm 環境はキャプション下に疑似コードが本文サイズで並ぶことが多い。
// 同じカラム内で行間が詰まって続く範囲だけを画像化し、下に戻る本文は含めない。
function estimateAlgorithmRect(
    captionLine: TextLine,
    lines: TextLine[],
    captionIndex: number,
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics
) {
    let pageMargin = 36;
    let padding = 8;
    let gapLimit = Math.max(bodyFontSize * 1.7, captionLine.fontSize * 1.7);
    let columnLeft = captionLine.x;
    let columnRight = Math.min(metric.width - pageMargin, columnLeft + columnWidth + padding);
    let codeLines: TextLine[] = [];
    let lastY = captionLine.y;

    for (let i = captionIndex + 1; i < lines.length; i++) {
        let line = lines[i];
        if (line.page != captionLine.page) {
            break;
        }

        if (line.y >= captionLine.y) {
            continue;
        }

        let sameColumn =
            line.x <= columnRight + padding &&
            line.x + line.width >= columnLeft - padding;
        if (!sameColumn) {
            continue;
        }

        let gap = lastY - line.y;
        if (gap > gapLimit && !isAlgorithmCodeLine(line)) {
            break;
        }

        if (
            isAlgorithmCaptionLine(line) ||
            isCaptionLine(line, bodyFontSize, columnWidth) ||
            isHeadingLine(line, bodyFontSize)
        ) {
            break;
        }

        codeLines.push(line);
        lastY = line.y;
    }

    if (codeLines.length < 2) {
        return null;
    }

    let minX = Math.min(...codeLines.map((line) => line.x));
    let maxX = Math.max(...codeLines.map((line) => line.x + line.width));
    let minY = Math.min(...codeLines.map((line) => line.y - line.fontSize * 0.25));
    let maxY = Math.max(...codeLines.map((line) => line.y + line.fontSize));
    let x = clamp(Math.min(columnLeft, minX) - padding, pageMargin, metric.width - pageMargin);
    let right = clamp(Math.max(columnRight, maxX) + padding, x + 24, metric.width - pageMargin);
    let y = clamp(minY - padding, 0, metric.height);
    let top = clamp(Math.min(maxY + padding, captionLine.y - captionLine.fontSize * 0.25), y + 24, metric.height);

    return {
        page: captionLine.page,
        x,
        y,
        width: right - x,
        height: top - y
    };
}

// 本文とキャプションを、走査方向やセル解像度に依存しない境界として共有する。
interface RegionBoundary {
    kind: "body" | "caption" | "heading";
    rect: PDF_Rect;
    lines: TextLine[];
}

function collectRegionBoundaries(
    lines: TextLine[], captions: FigureCandidate[], bodyFontSize: number,
    columnWidth: number, bodyLayout: BodyLayoutModel, graphics: PDF_GraphicObject[], metadata?: DocumentMetadata
): RegionBoundary[] {
    let captionTextLines = captions.flatMap((caption) => caption.captionLines);
    let captionLines = new Set(captionTextLines);
    let markers = lines.filter((line) => /^[\d*†‡]+$/.test(line.text.trim()));
    let blocks: RegionBoundary[] = captions.map((caption) => ({
        kind: "caption", rect: sourceRectFromLines(caption.captionLines)!, lines: caption.captionLines
    }));
    for (let group of metadata ? [metadata.titleLines, metadata.authorLines, metadata.affiliationLines, [...metadata.ignoredLines]] : []) {
        let rect = sourceRectFromLines(group);
        if (rect) blocks.push({kind: "heading", rect, lines: group});
    }
    let groups: TextLine[][] = [];
    let headings: TextLine[] = [];
    graphics = graphics.filter((graphic) => !captionTextLines.some((line) => rectsOverlap(graphic, lineRect(line))));
    let inGraphic = (rect: PDF_Rect) => graphics.some((graphic) => graphic.page == rect.page &&
        graphic.kind != "image" && graphic.width > columnWidth * 0.6 && graphic.height > bodyFontSize * 1.5 &&
        rectContainsRect(graphic, rect, bodyFontSize * 0.3));
    for (let line of [...lines].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
        if (captionLines.has(line)) continue;
        let footnote = markers.some((mark) => mark.page == line.page &&
            mark.fontSize < line.fontSize * 0.8 && mark.x >= line.x - bodyFontSize &&
            mark.x + mark.width <= line.x + 2 && mark.y >= line.y && mark.y - line.y < bodyFontSize);
        if (line.width > columnWidth * 0.7 && (line.text.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 5 &&
            (isListItemStart(line.text) || footnote)) {
            blocks.push({kind: "body", rect: lineRect(line), lines: [line]});
        }
        if (inGraphic(lineRect(line))) continue;
        if (isHeadingLine(line, bodyFontSize) || isTitleLine(line, bodyFontSize)) {
            headings.push(line);
            continue;
        }
        if (!isBodyLayoutLine(line, bodyLayout, bodyFontSize, columnWidth) || isEquationRelationLine(line, columnWidth)) continue;
        let group = groups.find((group) => {
            let last = group[group.length - 1];
            return last.page == line.page && last.y - line.y < bodyFontSize * 1.9 &&
                last.y > line.y && Math.abs(group[0].x - line.x) < bodyFontSize * 2;
        });
        if (group) group.push(line);
        else groups.push([line]);
    }
    for (let group of groups) {
        if (group.length >= 2 && group.some((line) => line.width > columnWidth * 0.7) && group.reduce((sum, line) => sum + line.text.length, 0) > 70) {
            blocks.push({kind: "body", rect: sourceRectFromLines(group)!, lines: group});
        }
    }
    for (let line of headings) {
        if (isHeadingText(line.text) || blocks.some((block) => block.kind == "body" && block.rect.page == line.page &&
            line.y >= rectTop(block.rect) && line.y - rectTop(block.rect) < bodyFontSize * 2 &&
            line.x < rectRight(block.rect) && line.x + line.width > block.rect.x)) {
            blocks.push({kind: "heading", rect: lineRect(line), lines: [line]});
        }
    }
    return blocks;
}

// 左右の所属は本文カラムから決め、本文のないページではキャプションの配置を使う。
function regionColumnBounds(
    anchor: PDF_Rect, captions: FigureCandidate[], layout: BodyLayoutModel,
    columnWidth: number, metric: PageMetrics
): PDF_Rect {
    let center = anchor.x + anchor.width / 2;
    let left = Math.max(8, Math.min(metric.minX, anchor.x) - 8);
    let right = Math.min(metric.width - 8, Math.max(metric.maxX, rectRight(anchor)) + 8);
    let columns = layout.columns.filter((column) => column.page == anchor.page);
    let xs = columns.map((column) => column.x).sort((a, b) => a - b);
    let splits: number[] = [];
    if (anchor.width < columnWidth * 1.2 && Math.abs(center - metric.width / 2) > columnWidth * 0.18) {
        if (xs.length < 2) xs = captions.map((caption) => caption.captionLines[0].x).sort((a, b) => a - b);
        if (xs.length < 2) xs = layout.columns.map((column) => column.x).sort((a, b) => a - b);
        let starts = xs.filter((x, i) => i == 0 || x - xs[i - 1] > columnWidth * 0.6);
        for (let i = 1; i < starts.length; i++) splits.push((starts[i - 1] + columnWidth + starts[i]) / 2);
    }
    for (let split of splits) {
        if (split > center) right = Math.min(right, split);
        else left = Math.max(left, split);
    }
    // 図だけのページは他ページの段位置を使うため、段の境界に小さな余裕を持たせる。
    if (!columns.length && captions.length == 1) {
        left = Math.max(8, left - 8);
        right = Math.min(metric.width - 8, right + 8);
    }
    return {page: anchor.page, x: left, width: Math.max(1, right - left), height: metric.height - 72, y: 36};
}

// 同じ横範囲にある本文・見出し・別キャプションを越えない探索範囲を作る。
function boundRegionAtText(anchor: PDF_Rect, owner: PDF_Rect, direction: 1 | -1, blockers: PDF_Rect[], margin: number) {
    let bottom = direction > 0 ? rectTop(anchor) + margin : owner.y;
    let top = direction < 0 ? anchor.y - margin : rectTop(owner);
    for (let block of blockers) {
        if (block.page != anchor.page) continue;
        let overlap = Math.min(rectRight(owner), rectRight(block)) - Math.max(owner.x, block.x);
        if (overlap < Math.min(owner.width, block.width) * 0.25) continue;
        if (direction > 0 && block.y >= rectTop(anchor)) top = Math.min(top, block.y - margin);
        if (direction < 0 && rectTop(block) <= anchor.y) bottom = Math.max(bottom, rectTop(block) + margin);
    }
    return top > bottom ? {...owner, y: bottom, height: top - bottom} : null;
}

// 所属範囲の内容を囲む。許容する空白幅は PDF 座標で指定し、セル解像度と分離する。
function fitRegionContent(mask: OccupancyMask, bounds: PDF_Rect, direction: 1 | -1, bodyFontSize: number, gapLimit: number) {
    let range = maskRectRange(mask, bounds);
    if (!range) return null;
    let x0 = range.x1, x1 = range.x0, y0 = range.y1, y1 = range.y0;
    let empty = 0;
    for (let y = direction > 0 ? range.y0 : range.y1 - 1; y >= range.y0 && y < range.y1; y += direction) {
        let occupied = false;
        for (let x = range.x0; x < range.x1; x++) {
            let bits = mask.cells[y * mask.width + x];
            if (!(bits & MASK_CONTENT) || (bits & MASK_HARD_TEXT_BLOCKER)) continue;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
            occupied = true;
        }
        empty = occupied ? 0 : empty + 1;
        if (y1 > y0 && empty * mask.cellSize > gapLimit) break;
    }
    if (x1 <= x0 || y1 <= y0) return null;
    let padding = bodyFontSize * 0.4;
    let rect = maskRangeToRect(mask, {x0, x1, y0, y1});
    return intersectRectsLoose({ ...rect, x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 }, bounds);
}

// 読み順に並んだ行から、キャプションと図表・疑似コード領域を先に集める。
function collectFigureCandidates(
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    pageMetrics: Map<number, PageMetrics>,
    bodyLayout: BodyLayoutModel,
    options?: PDF_ExtractOptions,
    pageInk = new Map<number, PDF_InkMask>(),
    metadata?: DocumentMetadata
) {
    let candidates: FigureCandidate[] = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let algorithmCaption = isAlgorithmCaptionLine(line);
        if (!algorithmCaption && !isCaptionLine(line, bodyFontSize, columnWidth)) {
            continue;
        }

        let caption = line.text;
        let endIndex = i;
        let metric = pageMetrics.get(line.page);
        if (!metric) {
            continue;
        }
        if (algorithmCaption) {
            candidates.push({
                startIndex: i,
                endIndex,
                captionLines: [line],
                node: new PDF_Node(
                    caption,
                    PDF_NodeType.FIGURE,
                    estimateAlgorithmRect(line, lines, i, bodyFontSize, columnWidth, metric) ?? undefined,
                    sourceRectFromLines([line])
                )
            });
            continue;
        }

        let captionLines = 1;
        while (captionLines < 20 && endIndex + 1 < lines.length) {
            let next = lines[endIndex + 1];
            let tableCaption = isTableCaption(caption);
            let captionComplete = captionLooksComplete(caption);
            let completedCaptionBlockContinuation =
                captionComplete &&
                isTightCaptionBlockContinuation(line, lines[endIndex], next, bodyFontSize);
            let openTableCaptionContinuation =
                tableCaption &&
                isOpenTableCaptionContinuation(caption, line, lines[endIndex], next, bodyFontSize, columnWidth);
            let wrappedCaptionContinuation =
                !tableCaption &&
                isWrappedCaptionContinuation(caption, line, lines[endIndex], next, bodyFontSize, columnWidth);
            if (captionComplete && !completedCaptionBlockContinuation && !wrappedCaptionContinuation) {
                break;
            }

            if (
                tableCaption &&
                !completedCaptionBlockContinuation &&
                !openTableCaptionContinuation &&
                !caption.endsWith("-") &&
                !/^[("']?\s*[a-z]/.test(next.text.trim()) &&
                !isUppercaseCaptionContinuation(next.text)
            ) {
                break;
            }

            if (
                isCaptionLine(next, bodyFontSize, columnWidth) ||
                isTitleLine(next, bodyFontSize) ||
                isHeadingLine(next, bodyFontSize) ||
                !openTableCaptionContinuation &&
                    !wrappedCaptionContinuation &&
                    !isLikelyCaptionContinuationLine(line, lines[endIndex], next, bodyFontSize, columnWidth)
            ) {
                break;
            }

            caption = appendLineText(caption, next.text);
            endIndex++;
            captionLines++;
        }

        let collectedCaptionLines = lines.slice(i, endIndex + 1);
        candidates.push({
            startIndex: i,
            endIndex,
            captionLines: collectedCaptionLines,
            node: new PDF_Node(
                caption,
                PDF_NodeType.FIGURE,
                undefined,
                sourceRectFromLines(collectedCaptionLines)
            )
        });
    }

    let masks = new Map<number, OccupancyMask>();
    let boundaries = collectRegionBoundaries(lines, candidates, bodyFontSize, columnWidth, bodyLayout, graphics, metadata);
    for (let metric of pageMetrics.values()) {
        let pageRect = {page: metric.page, x: 0, y: 0, width: metric.width, height: metric.height};
        let captions = candidates.filter((candidate) => candidate.captionLines[0].page == metric.page);
        if (!captions.length && !options?.debugMaskSink) continue;
        let pageGraphics = graphics.filter((graphic) => !graphicExcludedByCaption(graphic, captions.flatMap((c) => c.captionLines), metric));
        let mask = buildOccupancyMask(pageRect, lines, pageGraphics, bodyFontSize, columnWidth, metric, bodyLayout);
        let ink = pageInk.get(metric.page);
        if (ink) {
            for (let i = 0; i < mask.cells.length; i++) mask.cells[i] &= ~MASK_SHAPE;
            for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
                let ix = Math.floor(x * mask.cellSize / ink.cellSize);
                let iy = Math.floor(y * mask.cellSize / ink.cellSize);
                if (ix < ink.width && iy < ink.height && ink.cells[iy * ink.width + ix]) mask.cells[y * mask.width + x] |= MASK_SHAPE;
            }
        }
        // 行の間も本文の境界に含め、図形と同じセルに重なっても境界を維持する。
        for (let block of boundaries.filter((block) => block.rect.page == metric.page)) {
            drawRectToMask(mask, block.rect, block.kind == "body" ? MASK_BODY_LAYOUT : block.kind == "heading" ? MASK_HEADING : MASK_CAPTION);
        }
        masks.set(metric.page, mask);
        for (let candidate of [...captions].sort((a, b) => Number(isTableCaption(b.node.str)) - Number(isTableCaption(a.node.str)))) {
            if (isAlgorithmCaptionLine(candidate.captionLines[0])) continue;
            let log = scanLoggerForCaption(options, candidate.node.str);
            let anchor = sourceRectFromLines(candidate.captionLines)!;
            let owner = regionColumnBounds(anchor, captions, bodyLayout, columnWidth, metric);
            let direction: 1 | -1 = isTableCaption(candidate.node.str) ? -1 : 1;
            let limits = boundaries.filter((block) => !candidate.captionLines.includes(block.lines[0])).map((block) => block.rect);
            limits.push(...captions.filter((other) => other !== candidate && isTableCaption(other.node.str) && other.node.rect).map((other) => other.node.rect!));
            let bounds = boundRegionAtText(anchor, owner, direction, limits, bodyFontSize * 0.3);
            log?.(`region: caption="${candidate.node.str}" owner=${fmtRect(owner)} bounds=${fmtRect(bounds)}`);
            if (!bounds) continue;
            let rect = fitRegionContent(mask, bounds, direction, bodyFontSize, bodyFontSize * (direction < 0 ? 0.7 : 4));
            if (rect && rect.width >= 24 && rect.height >= 12) candidate.node.rect = rect;
            log?.(`region: result ${fmtRect(rect)}`);
        }
    }

    return {figures: candidates, boundaries, masks};
}

// PDF由来の不可視文字を除き、単独または式本体の行末にある括弧付き番号を探索の起点にする。
function isEquationNumberLine(line: TextLine) {
    let text = line.text.replace(/[\u0000-\u001f\u007f\ue000-\uf8ff]/g, "").trim();
    return /\(\d+[a-z]?\)$/.test(text);
}

// 等号や主要な演算記号を含む短い行を、表示数式の本体候補として扱う。
function isEquationRelationLine(line: TextLine, columnWidth: number) {
    return line.width <= columnWidth * 1.05 &&
        /(?:=|[≤≥≠≈≃≡×÷∫∑∏√⊕⊗∧∨˄˅])/.test(line.text);
}

// 本文と隣接する式番号を境界に、上下の式行・添字・罫線を一つの領域へまとめる。
function collectEquationCandidates(
    lines: TextLine[], bodyFontSize: number, columnWidth: number,
    pageMetrics: Map<number, PageMetrics>, bodyLayout: BodyLayoutModel,
    excludedRects: PDF_Rect[], boundaries: RegionBoundary[], graphics: PDF_GraphicObject[]
) {
    let candidates: EquationCandidate[] = [];
    let used = new Set<number>();
    let blockedLines = new Set(boundaries.flatMap((block) => block.lines));
    let available = lines.map((line, index) => ({line, index})).filter(({line}) =>
        !blockedLines.has(line) && !excludedRects.some((rect) => lineCenterInsideRect(line, rect))
    );
    let anchors = available.filter(({line}) => isEquationNumberLine(line) || isDisplayMathLine(line, columnWidth));
    // 番号付きのまとまりを先に確定し、その残りから番号なしの独立数式を拾う。
    anchors.sort((a, b) => Number(isEquationNumberLine(b.line)) - Number(isEquationNumberLine(a.line)));
    for (let anchor of anchors) {
        if (used.has(anchor.index)) continue;
        let numbered = isEquationNumberLine(anchor.line);
        let metric = pageMetrics.get(anchor.line.page)!;
        let numberRight = anchor.line.x + anchor.line.width;
        let columns = bodyLayout.columns.filter((column) => column.page == anchor.line.page);
        let column = columns.filter((column) => numbered
            ? Math.abs(column.x + columnWidth - numberRight) < columnWidth * 0.3
            : anchor.line.x >= column.x - bodyFontSize && numberRight <= column.x + columnWidth + bodyFontSize
        ).sort((a, b) => Math.abs(a.x + columnWidth - numberRight) - Math.abs(b.x + columnWidth - numberRight))[0];
        if (!column) continue;
        let owner = {page: anchor.line.page, x: column.x - bodyFontSize * 0.6, y: 0,
            width: columnWidth + bodyFontSize * 1.8, height: metric.height};
        let anchorRect = lineRect(anchor.line);
        let blockers = [...boundaries.map((block) => block.rect), ...excludedRects];
        let above = boundRegionAtText(anchorRect, owner, 1, blockers, 0);
        let below = boundRegionAtText(anchorRect, owner, -1, blockers, 0);
        if (!above || !below) continue;
        let bottom = below.y, top = rectTop(above);
        // 隣の式番号がある場合は、番号間の中間を越えて式を連結しない。
        for (let other of available) {
            if (other.index == anchor.index || !isEquationNumberLine(other.line) || other.line.page != owner.page ||
                Math.abs(other.line.x + other.line.width - (column.x + columnWidth)) > columnWidth * 0.3) continue;
            if (other.line.y > anchor.line.y) top = Math.min(top, (other.line.y + anchor.line.y) / 2);
            if (other.line.y < anchor.line.y) bottom = Math.max(bottom, (other.line.y + anchor.line.y) / 2);
        }
        let bounds = {...owner, y: bottom, height: top - bottom};
        let nearby = available.filter(({line, index}) => !used.has(index) && line.page == bounds.page &&
            line.y >= bottom && line.y <= top && line.x + line.width / 2 >= bounds.x && line.x + line.width / 2 <= rectRight(bounds));
        let seed = nearby.filter(({line}) => numbered ? isEquationRelationLine(line, columnWidth) : isDisplayMathLine(line, columnWidth))
            .sort((a, b) => Math.abs(a.line.y - anchor.line.y) - Math.abs(b.line.y - anchor.line.y))[0];
        if (!seed) continue;
        let members = new Set([seed.index]);
        let rect = lineRect(seed.line);
        // 接する行を上下とも同じ規則で集める。添字や分数も固定の探索高さに依存しない。
        let changed = true;
        while (changed) {
            changed = false;
            for (let entry of nearby) {
                if (members.has(entry.index)) continue;
                let box = lineRect(entry.line);
                let gap = Math.max(rect.y - rectTop(box), box.y - rectTop(rect), 0);
                if (gap > bodyFontSize * 0.65) continue;
                members.add(entry.index);
                rect = unionRects([rect, box])!;
                changed = true;
            }
        }
        if (!members.has(anchor.index)) continue;
        let sourceLines = [...members].map((index) => lines[index]);
        if (!numbered) {
            // 本文中の式や箇条書きの誤検出を避け、字下げと上下の余白がある式だけを採用する。
            if (rect.x < column.x + bodyFontSize * 0.8 || rect.width > columnWidth * 0.95 ||
                rect.y - bottom < bodyFontSize * 0.6 || top - rectTop(rect) < bodyFontSize * 0.6 ||
                sourceLines.some((line) => !isMathFragment(line.text) || isListItemStart(line.text) || /^[\s\u0000-\u001f]*[●◦▪\uf0b7]/.test(line.text))) continue;
        }
        let sourceRect = sourceRectFromLines(sourceLines)!;
        let decorations = graphics.filter((graphic) => graphic.page == rect.page && graphic.kind == "path" &&
            graphic.width <= columnWidth * 1.1 && graphic.height <= rect.height + bodyFontSize &&
            rectContainsRect(bounds, graphic, 0) && rectsOverlap(graphic, expandRect(rect, bodyFontSize * 0.4, metric)));
        rect = unionRects([rect, ...decorations])!;
        rect = intersectRectsLoose(expandRect(rect, bodyFontSize * 0.4, metric), bounds)!;
        if (!rect || excludedRects.some((excluded) => rectsOverlap(rect, excluded))) continue;
        for (let index of members) used.add(index);
        candidates.push({startIndex: Math.min(...members), lineIndices: [...members],
            node: new PDF_Node(sourceLines.sort((a, b) => b.y - a.y || a.x - b.x).map((line) => line.text).join(" "),
                PDF_NodeType.EQUATION, rect, sourceRect)});
    }
    return candidates;
}

function isMathFragment(text: string) {
    // 数式中の if/otherwise などの短い説明は許容し、通常の英文が続く行を除く。
    let words = text.match(/[A-Za-z]{3,}/g) ?? [];
    return words.filter((word) => !/^(?:if|otherwise|where|for|and|or|sin|cos|log|exp|max|min|lim)$/i.test(word)).length <= 2;
}

function isDisplayMathLine(line: TextLine, columnWidth: number) {
    return isEquationRelationLine(line, columnWidth) && isMathFragment(line.text);
}

function unionRects(rects: PDF_Rect[]): PDF_Rect | null {
    if (!rects.length) return null;
    let x = Math.min(...rects.map((rect) => rect.x)), y = Math.min(...rects.map((rect) => rect.y));
    return {page: rects[0].page, x, y,
        width: Math.max(...rects.map(rectRight)) - x, height: Math.max(...rects.map(rectTop)) - y};
}

function lineCenterInsideRect(line: TextLine, rect: PDF_Rect) {
    if (line.page != rect.page) {
        return false;
    }

    let centerX = line.x + line.width / 2;
    let centerY = line.y + line.fontSize / 2;
    return (
        centerX >= rect.x &&
        centerX <= rect.x + rect.width &&
        centerY >= rect.y &&
        centerY <= rect.y + rect.height
    );
}

// 抽出の中心処理。ページごとの TextItem から、タイトル・見出し・本文・図表を作る。
export function extractNodesFromPages(pages: Array<unknown[] | PDF_PageInput>, options?: PDF_ExtractOptions) {
    // TextItem をページごとの行へ復元し、文書全体の本文らしいサイズを推定する。
    let lines = pages.flatMap((page, index) => buildLinesForPage(pageItems(page), index + 1));
    let graphics = pages.flatMap((page) => pageGraphics(page));
    lines = splitMergedColumnLines(lines);
    let bodyFontSize = estimateBodyFontSize(lines);

    // 本文幅の代表値を使って、カラム移動や短い行による段落切れを判定する。
    let columnWidth = median(
        lines
            .filter((line) => Math.abs(line.fontSize - bodyFontSize) < 0.5 && line.width > 100)
            .map((line) => line.width),
        240
    );

    // 図表を画像として切り出すため、PDF ページ寸法と本文領域を用意する。
    let pageMetrics = estimatePageMetrics(lines, pages);
    let rasterPages = new Set(
        [...pageMetrics.values()]
            .filter((metric) => hasFullPageImage(graphics, metric))
            .map((metric) => metric.page)
    );
    let pageColumnWidth = median(
        [...pageMetrics.values()]
            .map((metric) => (metric.maxX - metric.minX) / 2 - 8)
            .filter((width) => width > 120),
        240
    );
    let figureColumnWidth = Math.max(columnWidth, Math.min(pageColumnWidth, 280));

    // 行単位の前処理: 見出し分割とページ番号除去を行う。小さい図表内テキストは矩形推定で使うため残す。
    lines = splitCaptionLines(splitHeadingLines(lines, bodyFontSize))
        .filter((line) => line.text != "")
        .filter((line) => !isPageDecoration(line, pageMetrics.get(line.page)));
    lines = normalizeDropCaps(lines, bodyFontSize);
    lines = splitMixedAuthorAffiliationLines(lines);
    let metadata = collectDocumentMetadata(lines, bodyFontSize, pageMetrics.get(1));

    // 読み順にした行から Figure/Table を先に集め、後続の本文抽出で除外できる形にする。
    pageMetrics = estimatePageMetrics(lines.filter((line) => !metadata.ignoredLines.has(line)), pages);
    let bodyLayout = estimateBodyLayout(lines, bodyFontSize, columnWidth);
    let readingLines = sortLinesForReading(lines);
    let {figures, boundaries, masks} = collectFigureCandidates(readingLines, graphics, bodyFontSize, figureColumnWidth, pageMetrics, bodyLayout, options, new Map(pages.flatMap((page, i) => !Array.isArray(page) && page.ink ? [[i + 1, page.ink] as const] : [])), metadata);
    emitDebugMasks(options, pageMetrics, lines, graphics, figures, bodyFontSize, columnWidth, bodyLayout, masks);
    let figureByStart = new Map(figures.map((figure) => [figure.startIndex, figure]));
    let captionLineIndices = new Set<number>();
    let figureRects = figures
        .map((figure) => figure.node.rect)
        .filter((rect): rect is PDF_Rect => rect != null);

    // 複数行キャプションは FIGURE ノードにまとめるので、元の行は本文候補から外す。
    for (let figure of figures) {
        for (let i = figure.startIndex; i <= figure.endIndex; i++) {
            captionLineIndices.add(i);
        }
    }

    // 図表領域を除外してから番号付き数式を集め、本文中の壊れた数式断片と置き換える。
    let equations = collectEquationCandidates(
        readingLines,
        bodyFontSize,
        columnWidth,
        pageMetrics,
        bodyLayout,
        figureRects,
        boundaries,
        graphics
    );
    let equationByStart = new Map(equations.map((equation) => [equation.startIndex, equation]));
    let equationLineIndices = new Set(equations.flatMap((equation) => equation.lineIndices));

    let nodes: PDF_Node[] = [];
    if (metadata.titleLines.length > 0) {
        let metadataTitle = metadata.titleLines.reduce((text, line) => appendLineText(text, line.text), "");
        nodes.push(new PDF_Node(
            metadataTitle,
            PDF_NodeType.TITLE,
            undefined,
            sourceRectFromLines(metadata.titleLines)
        ));
    }
    let metadataAuthors = authorTextFromLines(metadata.authorLines);
    if (metadataAuthors != "") {
        nodes.push(new PDF_Node(
            metadataAuthors,
            PDF_NodeType.AUTHOR,
            undefined,
            sourceRectFromLines(metadata.authorLines)
        ));
    }
    let metadataAffiliations = affiliationTextFromLines(metadata.affiliationLines);
    if (metadataAffiliations != "") {
        nodes.push(new PDF_Node(
            metadataAffiliations,
            PDF_NodeType.AFFILIATION,
            undefined,
            sourceRectFromLines(metadata.affiliationLines)
        ));
    }
    let title = "";
    let titleLines: TextLine[] = [];
    let paragraph = "";
    let paragraphLines: TextLine[] = [];
    let prevTextLine: TextLine | null = null;
    let inReferencesSection = false;

    // 複数行に分かれたタイトルを 1 つのノードにまとめる。
    function flushTitle() {
        if (title != "") {
            nodes.push(new PDF_Node(title, PDF_NodeType.TITLE, undefined, sourceRectFromLines(titleLines)));
            title = "";
            titleLines = [];
        }
    }

    // 連結中の本文段落を確定する。
    function flushParagraph() {
        if (paragraph != "") {
            nodes.push(new PDF_Node(paragraph, PDF_NodeType.TEXT, undefined, sourceRectFromLines(paragraphLines)));
            paragraph = "";
            paragraphLines = [];
        }
    }

    // キャプション行と図表矩形内の行を飛ばしながら、残りを構造ノードへ変換する。
    for (let i = 0; i < readingLines.length; i++) {
        let line = readingLines[i];
        let relaxedHeading = rasterPages.has(line.page);
        let figure = figureByStart.get(i);
        if (figure) {
            flushTitle();
            flushParagraph();
            nodes.push(figure.node);
            prevTextLine = null;
            continue;
        }

        let equation = equationByStart.get(i);
        if (equation) {
            flushTitle();
            flushParagraph();
            nodes.push(equation.node);
            prevTextLine = null;
            continue;
        }

        if (metadata.ignoredLines.has(line)) {
            prevTextLine = null;
            continue;
        }

        if (
            captionLineIndices.has(i) ||
            equationLineIndices.has(i) ||
            figureRects.some((rect) => lineCenterInsideRect(line, rect))
        ) {
            prevTextLine = null;
            continue;
        }

        // 回収できなかった数式記号は本文に残す。小さいという理由だけで式を失わない。
        if (!inReferencesSection && (isPullQuoteLine(line, bodyFontSize) ||
            line.fontSize < bodyFontSize - 1.2 && !isHeadingLine(line, bodyFontSize, relaxedHeading) &&
            !isDisplayMathLine(line, columnWidth))) {
            let prevLine = i > 0 ? readingLines[i - 1] : null;
            let nextLine = readingLines[i + 1];
            if (
                !nearBodyLine(line, prevLine, bodyFontSize, columnWidth) &&
                !nearBodyLine(line, nextLine, bodyFontSize, columnWidth)
            ) {
                prevTextLine = null;
            }
            continue;
        }

        if (isTitleLine(line, bodyFontSize)) {
            flushParagraph();
            title = appendLineText(title, line.text);
            titleLines.push(line);
            prevTextLine = null;
            inReferencesSection = false;
        }
        else if (isHeadingLine(line, bodyFontSize, relaxedHeading)) {
            flushTitle();
            flushParagraph();
            let headingLines = [line];
            let heading = line.text;
            let nextLine = readingLines[i + 1];
            if (
                relaxedHeading &&
                nextLine &&
                !figureByStart.has(i + 1) &&
                !captionLineIndices.has(i + 1) &&
                isSameLineHeadingContinuation(line, nextLine, bodyFontSize)
            ) {
                heading = appendLineText(heading, nextLine.text);
                headingLines.push(nextLine);
                i++;
            }
            nodes.push(new PDF_Node(heading, PDF_NodeType.HEADING, undefined, sourceRectFromLines(headingLines)));
            prevTextLine = null;
            inReferencesSection = isReferencesHeading(heading);
        }
        else {
            flushTitle();
            if (shouldStartParagraph(line, prevTextLine, columnWidth, paragraph, inReferencesSection)) {
                flushParagraph();
            }
            paragraph = appendLineText(paragraph, line.text);
            paragraphLines.push(line);
            prevTextLine = line;
        }
    }

    flushTitle();
    flushParagraph();
    return mergeAdjacentTextFragments(moveInterruptedFiguresAfterParagraphs(nodes), columnWidth);
}

// 旧 API 互換: 1 ページ分の TextItem だけから抽出する。
export function extractNodesFromTextItems(textItems: unknown[]) {
    return extractNodesFromPages([textItems]);
}

// 生成する HTML では PDF 由来文字列を必ずエスケープする。
function escapeHTML(str: string) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

interface HTMLLinkContext {
    ids: Map<PDF_Node, string>;
    sections: Map<string, string>;
    figures: Map<string, string>;
    tables: Map<string, string>;
    references: Map<string, string>;
}

function anchorKey(text: string) {
    return text.toLowerCase().replace(/\.$/, "");
}

function anchorId(prefix: string, key: string) {
    return `${prefix}-${key.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function uniqueAnchorId(base: string, used: Set<string>) {
    let id = base;
    for (let i = 2; used.has(id); i++) {
        id = `${base}-${i}`;
    }
    used.add(id);
    return id;
}

function captionAnchor(node: PDF_Node) {
    let match = node.str.match(new RegExp(`^(Figure|Fig\\.|Table)\\s+(${CAPTION_NUMBER_PATTERN})\\b`, "i"));
    if (!match) {
        return null;
    }

    let kind = /^Table$/i.test(match[1]) ? "table" : "figure";
    return {kind, key: anchorKey(match[2]), id: anchorId(kind, match[2])};
}

function headingAnchor(node: PDF_Node) {
    let text = node.str.trim();
    if (isAbstractHeading(text)) {
        return {kind: "section", key: "abstract", id: "abstract"};
    }
    if (isReferencesHeading(text)) {
        return {kind: "section", key: "references", id: "references"};
    }

    let arabic = arabicSectionNumbers(text);
    if (arabic) {
        let key = arabic.join(".");
        return {kind: "section", key, id: anchorId("section", key)};
    }

    let roman = text.match(/^([IVX]+)\./i);
    if (roman) {
        return {kind: "section", key: anchorKey(roman[1]), id: anchorId("section", roman[1])};
    }

    let letter = text.match(/^([A-Z])\./);
    return letter ? {kind: "section", key: anchorKey(letter[1]), id: anchorId("section", letter[1])} : null;
}

function referenceAnchor(node: PDF_Node) {
    let match = node.str.trim().match(/^(?:\[(\d+)\]|(\d+)\.)\s+/);
    if (!match) {
        return null;
    }

    let key = match[1] ?? match[2];
    return {kind: "reference", key, id: anchorId("ref", key)};
}

export function buildHTMLLinkContext(nodes: PDF_Node[]): HTMLLinkContext {
    let context: HTMLLinkContext = {
        ids: new Map(),
        sections: new Map(),
        figures: new Map(),
        tables: new Map(),
        references: new Map()
    };
    let used = new Set<string>();

    for (let node of nodes) {
        let target =
            node.type == PDF_NodeType.FIGURE ? captionAnchor(node) :
            node.type == PDF_NodeType.HEADING ? headingAnchor(node) :
            node.type == PDF_NodeType.TEXT ? referenceAnchor(node) :
            null;
        if (!target) {
            continue;
        }

        let id = uniqueAnchorId(target.id, used);
        context.ids.set(node, id);
        if (target.kind == "figure") {
            context.figures.set(target.key, id);
        }
        else if (target.kind == "table") {
            context.tables.set(target.key, id);
        }
        else if (target.kind == "reference") {
            context.references.set(target.key, id);
        }
        else {
            context.sections.set(target.key, id);
        }
    }

    return context;
}

export function nodeHTMLId(node: PDF_Node, context: HTMLLinkContext) {
    return context.ids.get(node) ?? "";
}

function linkHTML(label: string, targetId: string, currentId: string) {
    let escaped = escapeHTML(label);
    return targetId && targetId != currentId ? `<a href="#${escapeHTML(targetId)}">${escaped}</a>` : escaped;
}

function linkCitationHTML(label: string, context: HTMLLinkContext) {
    let body = label.slice(1, -1);
    return `[${body.replace(/\d+/g, (number) => {
        let target = context.references.get(number);
        return target ? `<a href="#${escapeHTML(target)}">${escapeHTML(number)}</a>` : escapeHTML(number);
    })}]`;
}

export function linkedNodeHTML(node: PDF_Node, context: HTMLLinkContext) {
    let currentId = nodeHTMLId(node, context);
    let linkReferences = !(node.type == PDF_NodeType.TEXT && referenceAnchor(node));
    let pattern = /\[(?:\d+(?:\s*[-–,]\s*\d+)*)\]|\b(?:Fig\.|Figure)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)\b|\bTable\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)\b|\b(?:Sec\.|Section|Sections|Secs\.)\s+\d+(?:\.\d+)*/gi;
    let html = "";
    let offset = 0;

    for (let match of node.str.matchAll(pattern)) {
        let text = match[0];
        let index = match.index ?? 0;
        html += escapeHTML(node.str.slice(offset, index));

        let target = "";
        let figure = text.match(/^(?:Fig\.|Figure)\s+(.+)$/i);
        let table = text.match(/^Table\s+(.+)$/i);
        let section = text.match(/^(?:Sec\.|Section|Sections|Secs\.)\s+(.+)$/i);
        if (text.startsWith("[") && linkReferences) {
            html += linkCitationHTML(text, context);
        }
        else if (figure) {
            target = context.figures.get(anchorKey(figure[1])) ?? "";
            html += linkHTML(text, target, currentId);
        }
        else if (table) {
            target = context.tables.get(anchorKey(table[1])) ?? "";
            html += linkHTML(text, target, currentId);
        }
        else if (section) {
            target = context.sections.get(anchorKey(section[1])) ?? "";
            html += linkHTML(text, target, currentId);
        }
        else {
            html += escapeHTML(text);
        }

        offset = index + text.length;
    }

    return html + escapeHTML(node.str.slice(offset));
}

// 連続する中黒付き本文だけを HTML の itemize へ変換するため、表示する項目本文を取り出す。
export function bulletListItemText(node: PDF_Node) {
    if (node.type != PDF_NodeType.TEXT) {
        return null;
    }

    let match = node.str.match(/^•\s+(.+)$/s);
    return match?.[1] ?? null;
}

// 構造ノード種別を HTML タグに対応づける。
export function nodeToHTMLElementName(node: PDF_Node) {
    switch (node.type) {
        case PDF_NodeType.TITLE:
            return "h1";
        case PDF_NodeType.AUTHOR:
        case PDF_NodeType.AFFILIATION:
            return "p";
        case PDF_NodeType.HEADING:
            return headingHTMLElementName(node.str);
        case PDF_NodeType.CAPTION:
            return "figcaption";
        case PDF_NodeType.FIGURE:
        case PDF_NodeType.EQUATION:
            return "figure";
        default:
            return "p";
    }
}

// 図表・数式の切り出し PNG は、PDF 上の bbox 幅を基準に HTML 表示幅を決める。
// 同じ倍率を使いながら上下限を置くことで、細い図の過剰な縮小と大きい図の過剰な拡大を避ける。
export function figureImageDisplayWidth(rect?: PDF_Rect) {
    if (!rect) {
        return "";
    }

    let width = clamp(rect.width * FIGURE_DISPLAY_SCALE, FIGURE_DISPLAY_MIN_WIDTH, FIGURE_DISPLAY_MAX_WIDTH);
    return `${Math.round(width)}px`;
}

// CLI 出力用の最小 HTML を生成する。翻訳時もタグ階層とリンク先は原文ノードから維持する。
export function nodesToHTML(nodes: PDF_Node[], structureNodes: PDF_Node[] = nodes) {
    if (nodes.length != structureNodes.length) {
        throw new Error("HTML content and structure node counts do not match.");
    }
    let linkContext = buildHTMLLinkContext(structureNodes);
    for (let [index, node] of nodes.entries()) {
        let id = nodeHTMLId(structureNodes[index], linkContext);
        if (id) {
            linkContext.ids.set(node, id);
        }
    }
    let body: string[] = [];

    for (let index = 0; index < nodes.length; index++) {
        let node = nodes[index];
        let listEnd = index;
        while (listEnd < nodes.length && bulletListItemText(structureNodes[listEnd]) != null) {
            listEnd++;
        }
        if (listEnd - index >= 2) {
            let items = nodes.slice(index, listEnd).map((item) => {
                let text = bulletListItemText(item) ?? item.str;
                return `<li>${linkedNodeHTML({...item, str: text}, linkContext)}</li>`;
            }).join("\n");
            body.push(`<ul>\n${items}\n</ul>`);
            index = listEnd - 1;
            continue;
        }

        let id = nodeHTMLId(node, linkContext);
        let idAttr = id ? ` id="${escapeHTML(id)}"` : "";
        let classAttr =
            node.type == PDF_NodeType.AUTHOR ? ` class="authors"` :
            node.type == PDF_NodeType.AFFILIATION ? ` class="affiliations"` :
            "";
        if (node.type == PDF_NodeType.FIGURE) {
            let imageWidth = figureImageDisplayWidth(node.rect);
            let imageStyle = imageWidth ? ` style="width: ${imageWidth};"` : "";
            let image = node.imageSrc
                ? `<img src="${escapeHTML(node.imageSrc)}" alt="${escapeHTML(node.str)}"${imageStyle}>`
                : "";
            body.push(`<figure${idAttr}>${image}<figcaption>${linkedNodeHTML(node, linkContext)}</figcaption></figure>`);
            continue;
        }
        if (node.type == PDF_NodeType.EQUATION) {
            let imageWidth = figureImageDisplayWidth(node.rect);
            let imageStyle = imageWidth ? ` style="width: ${imageWidth};"` : "";
            let image = node.imageSrc
                ? `<img src="${escapeHTML(node.imageSrc)}" alt="${escapeHTML(node.str)}"${imageStyle}>`
                : escapeHTML(node.str);
            body.push(`<figure class="equation"${idAttr}>${image}</figure>`);
            continue;
        }

        let tag = nodeToHTMLElementName(structureNodes[index]);
        body.push(`<${tag}${idAttr}${classAttr}>${linkedNodeHTML(node, linkContext)}</${tag}>`);
    }

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        main { max-width: 760px; margin: 0 auto; line-height: 1.55; }
        main a { color: #0645ad; text-decoration: none; }
        main a:hover { text-decoration: underline; }
        main > .authors { margin-bottom: 0.25rem; }
        main > .affiliations { margin-bottom: 1.5rem; color: #495057; font-size: 0.9rem; }
        main > ul { margin: 0.4rem 1.25rem 0.9rem; padding-left: 1.1rem; }
        main > ul > li + li { margin-top: 0.2rem; }
        figure { margin: 1.5rem 0; }
        figure img { display: block; max-width: 100%; height: auto; margin: 0 auto 0.5rem; }
        figure.equation { margin: 1rem 0; }
        figure.equation img { margin-bottom: 0; }
        figcaption { font-size: 0.92rem; color: #333; text-align: left; }
    </style>
</head>
<body>
<main>
${body.join("\n")}
</main>
</body>
</html>`;
}
