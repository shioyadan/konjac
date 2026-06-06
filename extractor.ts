"use strict";

// PDF.js の TextItem 群から論文らしい HTML 構造を推定する軽量な抽出器。
// 処理の流れ:
//   1. TextItem を座標付き TextPart に正規化する。
//   2. y 座標と x 座標から TextLine を復元する。
//   3. 文書全体から本文フォントサイズと本文幅を推定する。
//   4. ページ番号などの一般的な装飾を落とし、読み順を 2 段組み前提で整える。
//   5. Figure/Table/Algorithm キャプションから図表領域を粗く推定し、その領域内の文字行を本文から外す。
//   6. フォントサイズと文字列パターンから title/heading/figure/text に分類する。
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
    FIGURE = 5
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

// 1 ページ分の入力。既存 API 互換のため unknown[] だけを渡すこともできる。
export interface PDF_PageInput {
    // PDF.js の getTextContent().items。
    items: unknown[];
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
    // 本文、タイトル、見出し、キャプション、図表の種別。
    type: PDF_NodeType;
    // 図表ノードの場合、PDF ページから切り出す矩形。
    rect?: PDF_Rect;
    // CLI/viewer が rect から生成した画像。extractor 自体は画像生成を行わない。
    imageSrc?: string;

    constructor(str: string, type: PDF_NodeType, rect?: PDF_Rect) {
        this.str = str;
        this.type = type;
        if (rect) {
            this.rect = rect;
        }
    }
};

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

// キャプションから推定した図表ノードと、そのキャプション行の範囲。
interface FigureCandidate {
    // 読み順配列でのキャプション先頭行。
    startIndex: number;
    // 複数行キャプションの最終行。
    endIndex: number;
    // 出力する図表ノード。
    node: PDF_Node;
}

type Matrix = [number, number, number, number, number, number];

// 同じ行とみなす y 座標差の許容値。
const LINE_Y_EPSILON = 2.0;
// 同一 y 座標上で別行・別カラムとみなす横方向の隙間。
const COLUMN_GAP = 14.0;
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

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

// PDF.js の operator list から、実際に stroke/fill された path と画像の外接矩形を取り出す。
async function extractGraphicsFromPage(page: any, pageNumber: number, ops: Record<string, number>) {
    let operatorList = await page.getOperatorList();
    let graphics: PDF_GraphicObject[] = [];
    let ctm: Matrix = [...IDENTITY_MATRIX];
    let stack: Array<{ctm: Matrix; lineWidth: number}> = [];
    let lineWidth = 1;
    let pendingPath: PDF_GraphicObject | null = null;

    function paintPendingPath() {
        if (pendingPath) {
            graphics.push(pendingPath);
            pendingPath = null;
        }
    }

    for (let i = 0; i < operatorList.fnArray.length; i++) {
        let fn = operatorList.fnArray[i];
        let args = operatorList.argsArray[i] ?? [];

        if (fn == ops.save) {
            stack.push({ctm: [...ctm], lineWidth});
        }
        else if (fn == ops.restore) {
            let state = stack.pop();
            if (state) {
                ctm = state.ctm;
                lineWidth = state.lineWidth;
            }
        }
        else if (fn == ops.transform) {
            ctm = multiplyMatrix(ctm, asMatrix(args));
        }
        else if (fn == ops.setLineWidth && typeof args[0] == "number") {
            lineWidth = args[0];
        }
        else if (fn == ops.constructPath) {
            let box = operatorPathBox(args);
            let object = box ? transformBox(pageNumber, ctm, box, lineWidth, "path") : null;
            pendingPath = unionGraphicBox(pendingPath, object);
        }
        else if (
            fn == ops.stroke ||
            fn == ops.closeStroke ||
            fn == ops.fill ||
            fn == ops.eoFill ||
            fn == ops.fillStroke ||
            fn == ops.eoFillStroke ||
            fn == ops.closeFillStroke ||
            fn == ops.closeEOFillStroke
        ) {
            paintPendingPath();
        }
        else if (fn == ops.clip || fn == ops.eoClip || fn == ops.endPath) {
            pendingPath = null;
        }
        else if (fn == ops.paintImageXObject || fn == ops.paintJpegXObject || fn == ops.paintInlineImageXObject) {
            let object = transformBox(pageNumber, ctm, [0, 0, 1, 1], 0, "image");
            if (object) {
                graphics.push(object);
            }
        }
        else if (fn == ops.paintFormXObjectBegin) {
            ctm = multiplyMatrix(ctm, asMatrix(args[0]));
        }
    }

    return graphics;
}

// CLI/viewer からは TextContent と Graphics を別々に扱わず、ページ入力としてまとめて渡す。
export async function extractPageInputFromPDFPage(page: any, pageNumber: number, ops: Record<string, number>) {
    let viewport = page.getViewport({scale: 1});
    let [textContent, graphics] = await Promise.all([
        page.getTextContent(),
        extractGraphicsFromPage(page, pageNumber, ops)
    ]);

    return {
        items: textContent.items,
        graphics,
        width: viewport.width,
        height: viewport.height
    };
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
        if (line.fontSize < 7 || line.fontSize > 12.5 || line.text.length < 20) {
            continue;
        }
        let key = Math.round(line.fontSize * 2) / 2;
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
function isPageDecoration(line: TextLine) {
    return /^\d+$/.test(line.text) && line.fontSize <= 12;
}

const CAPTION_NUMBER_PATTERN = "(?:\\d+|[IVXLCDM]+)";
const CAPTION_LINE_PATTERN = new RegExp(`^(?:Figure|Fig\\.|Table)\\s+${CAPTION_NUMBER_PATTERN}(?:\\s*[:.]|$)`, "i");
const TABLE_CAPTION_PATTERN = new RegExp(`^Table\\s+${CAPTION_NUMBER_PATTERN}\\b`, "i");
const ALGORITHM_CAPTION_PATTERN = /^Algorithm\s+\d+\b/i;

// 図表キャプションの先頭行を検出する。
function isCaptionLine(line: TextLine, bodyFontSize?: number, columnWidth?: number) {
    if (!CAPTION_LINE_PATTERN.test(line.text)) {
        return false;
    }

    // "Fig. 12. The ..." のように本文行頭に図番号参照が来る場合を、実キャプションと区別する。
    if (
        bodyFontSize != null &&
        columnWidth != null &&
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
    return line.page == 1 && line.fontSize >= bodyFontSize + 5;
}

function isAbstractHeading(text: string) {
    return /^(?:ABSTRACT|Abstract)$/.test(text);
}

function isReferencesHeading(text: string) {
    return /^(?:REFERENCES|References)$/.test(text);
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
        isNumberedSectionHeading(text)
    );
}

// フォントサイズと文字列パターンから見出し行を判定する。
function isHeadingLine(line: TextLine, bodyFontSize: number) {
    if (isTitleLine(line, bodyFontSize)) {
        return false;
    }

    if (isAbstractHeading(line.text) || isReferencesHeading(line.text)) {
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
        return line.fontSize >= bodyFontSize - 0.5 && line.text.length < 140;
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

// 2 段組み論文を想定し、ページごとに左カラム、右カラムの順へ並べる。
function sortLinesForReading(lines: TextLine[]) {
    let result: TextLine[] = [];
    let pages = [...new Set(lines.map((line) => line.page))].sort((a, b) => a - b);

    for (let page of pages) {
        let pageLines = lines.filter((line) => line.page == page);
        let maxEnd = Math.max(...pageLines.map((line) => line.x + line.width), 612);
        let centerX = maxEnd / 2;
        let left = pageLines.filter((line) => line.x < centerX);
        let right = pageLines.filter((line) => line.x >= centerX);
        let byY = (a: TextLine, b: TextLine) => b.y - a.y || a.x - b.x;

        result.push(...left.sort(byY), ...right.sort(byY));
    }

    return result;
}

// 行間、インデント、カラム遷移から段落の切れ目を推定する。
function shouldStartParagraph(line: TextLine, prevLine: TextLine | null, columnWidth: number, paragraph: string) {
    if (!prevLine) {
        return false;
    }

    if (paragraph.startsWith("•") && !line.text.startsWith("•")) {
        return false;
    }

    if (/^\d+\.\s/.test(paragraph) && !/^\d+\.\s/.test(line.text)) {
        return false;
    }

    if (line.text.startsWith("•")) {
        return true;
    }

    if (line.page != prevLine.page) {
        return false;
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
        /^(?:[A-Z]|[IVX]+)\.\s+/.test(trimmed)
    );
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

        result.push(new PDF_Node(text, PDF_NodeType.TEXT), ...delayedFigures);
        i = cursor;
    }

    return result;
}

// 図をまたがない場合でも、数式断片などで隣接 TEXT に割れた本文は最後にまとめ直す。
function mergeAdjacentTextFragments(nodes: PDF_Node[]) {
    let result: PDF_Node[] = [];

    for (let node of nodes) {
        let prev = result[result.length - 1];
        if (
            prev?.type == PDF_NodeType.TEXT &&
            node.type == PDF_NodeType.TEXT &&
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

function figureCaptionClearY(line: TextLine) {
    return line.y + line.fontSize + Math.max(2, line.fontSize * 0.25);
}

function rectRight(rect: PDF_Rect) {
    return rect.x + rect.width;
}

function rectTop(rect: PDF_Rect) {
    return rect.y + rect.height;
}

function rectCenterX(rect: PDF_Rect) {
    return rect.x + rect.width / 2;
}

function rectCenterY(rect: PDF_Rect) {
    return rect.y + rect.height / 2;
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

function unionRects(a: PDF_Rect, b: PDF_Rect): PDF_Rect {
    let x = Math.min(a.x, b.x);
    let y = Math.min(a.y, b.y);
    let right = Math.max(rectRight(a), rectRight(b));
    let top = Math.max(rectTop(a), rectTop(b));
    return {page: a.page, x, y, width: right - x, height: top - y};
}

function expandRect(rect: PDF_Rect, margin: number, metric: PageMetrics): PDF_Rect {
    let x = clamp(rect.x - margin, 0, metric.width);
    let y = clamp(rect.y - margin, 0, metric.height);
    let right = clamp(rectRight(rect) + margin, x, metric.width);
    let top = clamp(rectTop(rect) + margin, y, metric.height);
    return {...rect, x, y, width: right - x, height: top - y};
}

function isWideFigureWidth(width: number, columnWidth: number, metric: PageMetrics) {
    return width > metric.width * 0.48 ||
        width > columnWidth * 1.25 && width > metric.width * 0.4;
}

// キャプション行を基準に、Figure は上側、Table は下側を図表領域として切り出す。
// これは一般的な論文レイアウト向けの経験則で、個別 PDF 固有の文字列には依存しない。
function estimateFigureRect(caption: string, line: TextLine, columnWidth: number, metric: PageMetrics) {
    let tableCaption = isTableCaption(caption);

    // 図表の端に本文やページ外領域を含めすぎないよう、最低限の余白を置く。
    let pageMargin = 36;
    let padding = Math.max(6, line.fontSize * 0.8);

    // キャプションがカラム幅を大きく超える場合は、単一カラムではなくページ幅に近い図表とみなす。
    let isWide = isWideFigureWidth(line.width, columnWidth, metric);

    // 短いキャプションは中央寄せされることがあるため、キャプション左端だけを図の左端とはみなさない。
    // ただし隣のカラム本文を巻き込まないよう、カラム左端へ寄せる量には上限を置く。
    let rightColumnLeft = Math.max(metric.width / 2, metric.maxX - columnWidth);
    let columnLeft = line.x >= metric.width / 2 ? rightColumnLeft : metric.minX;
    let captionX = Math.max(pageMargin, line.x - 4);
    let columnX = Math.max(pageMargin, columnLeft - 4);
    let maxColumnSnap = Math.min(columnWidth * 0.25, 48);
    let x = isWide
        ? Math.max(pageMargin, metric.minX - 4)
        : Math.min(captionX, Math.max(columnX, captionX - maxColumnSnap));
    if (tableCaption && !isWide) {
        // 表ラベルは短く中央寄せされやすいので、表本体はカラム左端から切り出す。
        x = columnX;
    }

    // wide 図表は本文領域全体、通常図表は推定カラム幅を基本幅として切り出す。
    let width = isWide
        ? Math.min(metric.width - x - pageMargin, Math.max(metric.maxX - x + 4, line.width + padding * 2))
        : Math.min(metric.width - x - pageMargin, Math.max(columnWidth + padding, line.width + padding * 2));

    // 最初の矩形は保守的な最大高さに抑える。後段で図内テキストや本文行を使ってさらに詰める。
    let heightLimit = tableCaption
        ? Math.min(metric.height * 0.34, 260)
        : Math.min(metric.height * 0.34, 240);
    let y = 0;
    let height = 0;

    if (tableCaption) {
        // Table はキャプションが表の上に置かれることが多いので、キャプション下側を候補にする。
        let top = line.y - line.fontSize - padding;
        height = Math.min(heightLimit, Math.max(0, top - pageMargin));
        y = top - height;
    }
    else {
        // Figure はキャプションが図の下に置かれることが多いので、キャプション上側を候補にする。
        // キャプション文字を画像へ含めない程度にだけ間隔を空ける。
        y = figureCaptionClearY(line);
        height = Math.min(heightLimit, Math.max(0, metric.height - pageMargin - y));
    }

    // 推定値がページ外へ出た場合に、Canvas crop が破綻しない範囲へ丸める。
    x = clamp(x, 0, metric.width);
    y = clamp(y, 0, metric.height);
    width = clamp(width, 0, metric.width - x);
    height = clamp(height, 0, metric.height - y);

    // 小さすぎる矩形は画像化しても意味が薄いので、図表候補から外す。
    if (width < 24 || height < 24) {
        return null;
    }

    return {
        page: line.page,
        x,
        y,
        width,
        height
    };
}

function isParagraphLikeLine(line: TextLine, bodyFontSize: number, columnWidth: number) {
    return (
        Math.abs(line.fontSize - bodyFontSize) < 1.0 &&
        line.width > columnWidth * 0.85 &&
        line.text.length > 55
    );
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

function isFormulaOnlyLine(line: TextLine, columnWidth: number) {
    let text = line.text.trim();
    if (line.width > columnWidth * 0.4) {
        return false;
    }

    if (/^[(){}\[\]⌊⌋∑∼=+\-*/,:;\s]+$/.test(text)) {
        return true;
    }

    return /^(?:O|P|M|N|k)$/.test(text) && line.width < columnWidth * 0.08;
}

// 本文フォントより小さい行と記号だけの行は、図表ラベルや数式部品として扱う。
function shouldDropStructuralFragmentLine(line: TextLine, bodyFontSize: number, columnWidth: number) {
    if (isCaptionLine(line) || isHeadingLine(line, bodyFontSize) || isTitleLine(line, bodyFontSize)) {
        return false;
    }

    return line.fontSize < bodyFontSize - 1.2 || isFormulaOnlyLine(line, columnWidth);
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

// Table では下側に本文が続くことが多いため、crop 内で本文らしい行が現れたら直前で切る。
function trimTableRectAtBodyText(rect: PDF_Rect, lines: TextLine[], captionEndIndex: number, bodyFontSize: number, columnWidth: number) {
    let top = rect.y + rect.height;

    for (let i = captionEndIndex + 1; i < lines.length; i++) {
        let line = lines[i];
        if (line.page != rect.page) {
            break;
        }

        if (line.y > top || line.y < rect.y) {
            continue;
        }

        if (!isParagraphLikeLine(line, bodyFontSize, columnWidth)) {
            continue;
        }

        let bottom = clamp(line.y + line.fontSize + Math.max(6, line.fontSize), rect.y, top - 24);
        return {
            ...rect,
            y: bottom,
            height: top - bottom
        };
    }

    return rect;
}

// 表本体は小さいフォントの行が縦に連続することが多いので、その範囲で crop を詰める。
function fitTableRectToInnerText(
    rect: PDF_Rect,
    lines: TextLine[],
    captionLine: TextLine,
    captionEndIndex: number,
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics
) {
    let tableLines: TextLine[] = [];
    let lastY = captionLine.y;
    let gapLimit = Math.max(bodyFontSize * 2.6, 24);

    for (let i = captionEndIndex + 1; i < lines.length; i++) {
        let line = lines[i];
        if (line.page != rect.page) {
            break;
        }

        if (line.y >= captionLine.y || line.y < rect.y) {
            continue;
        }

        let horizontallyRelated =
            line.x <= rect.x + rect.width + 12 &&
            line.x + line.width >= rect.x - 12;
        if (!horizontallyRelated) {
            continue;
        }

        let gap = lastY - line.y;
        if (tableLines.length > 0 && gap > gapLimit) {
            break;
        }

        if (isCaptionLine(line, bodyFontSize, columnWidth) || isHeadingLine(line, bodyFontSize)) {
            break;
        }

        if (tableLines.length > 0 && isParagraphLikeLine(line, bodyFontSize, columnWidth)) {
            break;
        }

        tableLines.push(line);
        lastY = line.y;
    }

    if (tableLines.length < 2) {
        return null;
    }

    let pageMargin = 36;
    let padding = 8;
    let minX = Math.min(...tableLines.map((line) => line.x));
    let maxX = Math.max(...tableLines.map((line) => line.x + line.width));
    let minY = Math.min(...tableLines.map((line) => line.y - line.fontSize * 0.25));
    let maxY = Math.max(...tableLines.map((line) => line.y + line.fontSize));
    let captionEndLine = lines[captionEndIndex] ?? captionLine;
    let captionBottom = captionEndLine.y - captionEndLine.fontSize * 0.3;
    let x = clamp(Math.min(rect.x, minX - padding), pageMargin, metric.width - pageMargin);
    let right = clamp(Math.max(rect.x + rect.width, maxX + padding), x + 24, metric.width - pageMargin);
    let y = clamp(minY - padding, 0, metric.height);
    let top = clamp(Math.min(maxY + padding, captionBottom - 1), y + 24, metric.height);

    return {
        ...rect,
        x,
        y,
        width: right - x,
        height: top - y
    };
}

interface GraphicCluster {
    rect: PDF_Rect;
    count: number;
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

function graphicSearchRect(captionLine: TextLine, rect: PDF_Rect, tableCaption: boolean, columnWidth: number, metric: PageMetrics) {
    let pageMargin = 36;
    let wide = isWideFigureWidth(rect.width, columnWidth, metric) ||
        isWideFigureWidth(captionLine.width, columnWidth, metric);
    let x = wide ? metric.minX - 12 : Math.min(rect.x, captionLine.x - columnWidth * 0.3);
    let right = wide ? metric.maxX + 12 : Math.max(rectRight(rect), captionLine.x + captionLine.width + columnWidth * 0.3);
    let verticalLimit = Math.max(280, metric.height * 0.42);
    let y = tableCaption
        ? Math.max(pageMargin, captionLine.y - verticalLimit)
        : captionLine.y + captionLine.fontSize * 0.4;
    let top = tableCaption
        ? captionLine.y - captionLine.fontSize * 0.25
        : Math.min(metric.height - pageMargin, captionLine.y + verticalLimit);

    x = clamp(x, pageMargin, metric.width - pageMargin);
    right = clamp(right, x + 24, metric.width - pageMargin);
    y = clamp(y, 0, metric.height);
    top = clamp(top, y + 24, metric.height);
    return {page: captionLine.page, x, y, width: right - x, height: top - y};
}

function clusterGraphicRects(graphics: PDF_GraphicObject[], metric: PageMetrics) {
    let clusters: GraphicCluster[] = [];

    for (let graphic of graphics) {
        let rect = expandRect(graphic, Math.max(3, graphic.strokeWidth ?? 1), metric);
        let merged = false;
        for (let cluster of clusters) {
            if (rectsOverlap(cluster.rect, rect, 10)) {
                cluster.rect = unionRects(cluster.rect, rect);
                cluster.count++;
                merged = true;
                break;
            }
        }
        if (!merged) {
            clusters.push({rect, count: 1});
        }
    }

    for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
            if (!rectsOverlap(clusters[i].rect, clusters[j].rect, 10)) {
                continue;
            }
            clusters[i].rect = unionRects(clusters[i].rect, clusters[j].rect);
            clusters[i].count += clusters[j].count;
            clusters.splice(j, 1);
            i = -1;
            break;
        }
    }

    return clusters;
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

function isHardCropBlockerLine(line: TextLine, bodyFontSize: number, columnWidth: number, tableCaption: boolean) {
    if (isCaptionLine(line, bodyFontSize, columnWidth) || isHeadingLine(line, bodyFontSize)) {
        return true;
    }

    // 表内の行は本文と同じサイズ・幅になることがあるので、本文ブロックとしては Figure だけで見る。
    if (tableCaption) {
        return false;
    }

    if (isParagraphLikeLine(line, bodyFontSize, columnWidth)) {
        return true;
    }

    if (isBodySizedProseFragment(line, bodyFontSize)) {
        return true;
    }

    // 短い本文行や複数行キャプションの続きは paragraphLike から外れるため、本文サイズで十分長い行は
    // Figure の外側に残す対象として扱う。図中ラベルは小さい文字か短い行になりやすいのでここでは除外される。
    return line.fontSize >= bodyFontSize - 0.4 &&
        line.width > columnWidth * 0.45 &&
        line.text.length > 24;
}

function isTopEdgeTextBlocker(line: TextLine, rect: PDF_Rect, bodyFontSize: number, columnWidth: number, tableCaption: boolean) {
    if (tableCaption) {
        return false;
    }

    let box = lineRect(line);
    let topGap = Math.abs(rectTop(rect) - rectTop(box));
    let nearBodySizedText = line.fontSize >= bodyFontSize - 2.0 &&
        line.width > columnWidth * 0.45;
    let wideProseText = line.fontSize >= bodyFontSize - 3.0 &&
        line.width > columnWidth * 0.7 &&
        /[a-z]{3,}/i.test(line.text);

    // Figure の上端にだけ小さめの長いテキストが残る場合は、直前 Figure の複数行キャプションや
    // 本文末尾を巻き込んでいることが多い。下端は図中の横軸ラベルが出やすいので、この判定では触らない。
    return (
        rectsOverlap(rect, box) &&
        topGap <= Math.max(12, line.fontSize * 1.5) &&
        (nearBodySizedText || wideProseText) &&
        line.text.length > 24
    );
}

function isTableProseLikeChunk(line: TextLine, bodyFontSize: number, columnWidth: number) {
    return line.fontSize >= bodyFontSize - 0.4 &&
        line.width > columnWidth * 0.35 &&
        line.text.length > 20 &&
        /[a-z]{3,}/i.test(line.text) &&
        /\s/.test(line.text);
}

function isBodySizedProseFragment(line: TextLine, bodyFontSize: number) {
    return line.fontSize >= Math.max(7, bodyFontSize - 0.8) &&
        line.text.length > 12 &&
        /[a-z]{3,}/i.test(line.text) &&
        /\s/.test(line.text);
}

function isTableEdgeTextBlocker(line: TextLine, rect: PDF_Rect, bodyFontSize: number, columnWidth: number, tableCaption: boolean) {
    if (!tableCaption) {
        return false;
    }

    let box = lineRect(line);
    let edgeBand = Math.max(12, line.fontSize * 1.6);
    let crossesOuterSide =
        (anchorCrossesVerticalEdge(box, rect.x, rect) && rectRight(box) <= rect.x + edgeBand) ||
        (anchorCrossesVerticalEdge(box, rectRight(rect), rect) && box.x >= rectRight(rect) - edgeBand);
    let paragraphLike = isParagraphLikeLine(line, bodyFontSize, columnWidth);

    // 表の内部は本文サイズの文字を含むため、全面的にはブロックしない。表の下に続く本文や
    // 隣カラムの本文が bbox の端にかかっている場合だけ、表の外側として切り落とす。
    return (
        rectsOverlap(rect, box) &&
        (
            (paragraphLike && box.y - rect.y <= edgeBand) ||
            (crossesOuterSide && (paragraphLike || isTableProseLikeChunk(line, bodyFontSize, columnWidth)))
        )
    );
}

function hardCropBlockers(
    rect: PDF_Rect,
    lines: TextLine[],
    bodyFontSize: number,
    columnWidth: number,
    tableCaption: boolean
) {
    return lines
        .filter((line) =>
            line.page == rect.page &&
            (
                isHardCropBlockerLine(line, bodyFontSize, columnWidth, tableCaption) ||
                isTopEdgeTextBlocker(line, rect, bodyFontSize, columnWidth, tableCaption) ||
                isTableEdgeTextBlocker(line, rect, bodyFontSize, columnWidth, tableCaption)
            )
        )
        .map(lineRect)
        .filter((blocker) =>
            rectsOverlap(rect, blocker) &&
            rectCenterY(blocker) >= rect.y &&
            rectCenterY(blocker) <= rectTop(rect)
        );
}

function validCropRect(rect: PDF_Rect, metric: PageMetrics) {
    return rect.width >= 24 && rect.height >= 24 &&
        rect.x >= 0 && rect.y >= 0 && rectRight(rect) <= metric.width && rectTop(rect) <= metric.height;
}

function shrinkRectAwayFromBlocker(rect: PDF_Rect, blocker: PDF_Rect, metric: PageMetrics, preferSideCut: boolean) {
    let right = rectRight(rect);
    let top = rectTop(rect);
    let margin = 4;
    let edgeBand = Math.max(12, blocker.height * 1.5);
    let edgeCandidates: PDF_Rect[] = [];
    let sideCandidates: PDF_Rect[] = [];

    // bbox の端にかかった本文は、その端だけを動かして取り除く。面積だけで選ぶと、
    // 下端の本文を消すために横幅を詰めるような不自然な crop になりやすい。
    if (preferSideCut && blocker.width > rect.width * 0.35) {
        if (blocker.x > rect.x + rect.width * 0.45) {
            sideCandidates.push({...rect, width: blocker.x - margin - rect.x});
        }
        if (rectRight(blocker) < rect.x + rect.width * 0.55) {
            sideCandidates.push({...rect, x: rectRight(blocker) + margin, width: right - (rectRight(blocker) + margin)});
        }

        let sideCut = sideCandidates
            .filter((candidate) => validCropRect(candidate, metric))
            .filter((candidate) => !rectsOverlap(candidate, blocker))
            .sort((a, b) => rectArea(b) - rectArea(a))[0];
        if (sideCut) {
            return sideCut;
        }
    }

    if (blocker.y - rect.y <= edgeBand) {
        edgeCandidates.push({...rect, y: rectTop(blocker) + margin, height: top - (rectTop(blocker) + margin)});
    }
    if (top - rectTop(blocker) <= edgeBand) {
        edgeCandidates.push({...rect, height: blocker.y - margin - rect.y});
    }
    if (blocker.x - rect.x <= edgeBand) {
        edgeCandidates.push({...rect, x: rectRight(blocker) + margin, width: right - (rectRight(blocker) + margin)});
    }
    if (right - rectRight(blocker) <= edgeBand) {
        edgeCandidates.push({...rect, width: blocker.x - margin - rect.x});
    }

    let edgeCut = edgeCandidates
        .filter((candidate) => validCropRect(candidate, metric))
        .filter((candidate) => !rectsOverlap(candidate, blocker))
        .sort((a, b) => rectArea(b) - rectArea(a))[0];
    if (edgeCut) {
        return edgeCut;
    }

    let candidates: PDF_Rect[] = [
        {...rect, x: rectRight(blocker) + margin, width: right - (rectRight(blocker) + margin)},
        {...rect, width: blocker.x - margin - rect.x},
        {...rect, y: rectTop(blocker) + margin, height: top - (rectTop(blocker) + margin)},
        {...rect, height: blocker.y - margin - rect.y}
    ];

    return candidates
        .filter((candidate) => validCropRect(candidate, metric))
        .filter((candidate) => !rectsOverlap(candidate, blocker))
        .sort((a, b) => rectArea(b) - rectArea(a))[0] ?? rect;
}

function trimHardCropBlockers(
    rect: PDF_Rect,
    lines: TextLine[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    tableCaption: boolean
) {
    let current = rect;
    for (let pass = 0; pass < 6; pass++) {
        let blockers = hardCropBlockers(current, lines, bodyFontSize, columnWidth, tableCaption);
        if (blockers.length == 0) {
            break;
        }

        let next = shrinkRectAwayFromBlocker(current, blockers[0], metric, !tableCaption);
        if (next == current) {
            break;
        }
        current = next;
    }

    return current;
}

function isSoftCropAnchorLine(line: TextLine, bodyFontSize: number, columnWidth: number, tableCaption: boolean) {
    return (
        !isHardCropBlockerLine(line, bodyFontSize, columnWidth, tableCaption) &&
        line.text.length > 1 &&
        (line.fontSize < bodyFontSize - 0.8 || line.width < columnWidth * 0.7)
    );
}

function anchorCrossesVerticalEdge(anchor: PDF_Rect, edgeX: number, rect: PDF_Rect) {
    return anchor.x < edgeX && rectRight(anchor) > edgeX &&
        rectTop(anchor) > rect.y && anchor.y < rectTop(rect);
}

function anchorCrossesHorizontalEdge(anchor: PDF_Rect, edgeY: number, rect: PDF_Rect) {
    return anchor.y < edgeY && rectTop(anchor) > edgeY &&
        rectRight(anchor) > rect.x && anchor.x < rectRight(rect);
}

function safeCropExpansion(
    candidate: PDF_Rect,
    lines: TextLine[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    tableCaption: boolean
) {
    return validCropRect(candidate, metric) &&
        hardCropBlockers(candidate, lines, bodyFontSize, columnWidth, tableCaption).length == 0;
}

function expandRectToAvoidSoftCuts(
    rect: PDF_Rect,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    tableCaption: boolean
) {
    let current = rect;
    let search = expandRect(rect, 24, metric);
    let anchors = [
        ...lines
            .filter((line) =>
                line.page == rect.page &&
                isSoftCropAnchorLine(line, bodyFontSize, columnWidth, tableCaption)
            )
            .map(lineRect),
        ...graphics.filter((graphic) =>
            graphic.page == rect.page &&
            usefulGraphicObject(graphic, metric)
        )
    ].filter((anchor) => rectsOverlap(anchor, search));

    for (let anchor of anchors) {
        let right = rectRight(current);
        let top = rectTop(current);
        let margin = 4;
        let candidates: PDF_Rect[] = [];

        if (anchorCrossesVerticalEdge(anchor, current.x, current)) {
            let x = Math.max(current.x - 24, anchor.x - margin, 0);
            candidates.push({...current, x, width: right - x});
        }
        if (anchorCrossesVerticalEdge(anchor, right, current)) {
            let newRight = Math.min(right + 24, rectRight(anchor) + margin, metric.width);
            candidates.push({...current, width: newRight - current.x});
        }
        if (anchorCrossesHorizontalEdge(anchor, current.y, current)) {
            let y = Math.max(current.y - 24, anchor.y - margin, 0);
            candidates.push({...current, y, height: top - y});
        }
        if (anchorCrossesHorizontalEdge(anchor, top, current)) {
            let newTop = Math.min(top + 24, rectTop(anchor) + margin, metric.height);
            candidates.push({...current, height: newTop - current.y});
        }

        let next = candidates
            .filter((candidate) => safeCropExpansion(candidate, lines, bodyFontSize, columnWidth, metric, tableCaption))
            .sort((a, b) => rectArea(a) - rectArea(b))[0];
        if (next) {
            current = next;
        }
    }

    return current;
}

function trimTableBottomProseChunks(rect: PDF_Rect, lines: TextLine[], bodyFontSize: number, columnWidth: number, metric: PageMetrics) {
    let edgeBand = Math.max(12, bodyFontSize * 1.6);
    let blocker = lines
        .filter((line) =>
            line.page == rect.page &&
            isTableProseLikeChunk(line, bodyFontSize, columnWidth)
        )
        .map(lineRect)
        .filter((box) => rectsOverlap(rect, box) && box.y - rect.y <= edgeBand)
        .sort((a, b) => a.y - b.y)[0];
    if (!blocker) {
        return rect;
    }

    let y = rectTop(blocker) + 4;
    let candidate = {...rect, y, height: rectTop(rect) - y};
    return validCropRect(candidate, metric) ? candidate : rect;
}

function avoidBodyAndEdgeCuts(
    rect: PDF_Rect,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    tableCaption: boolean
) {
    let trimmed = trimHardCropBlockers(rect, lines, bodyFontSize, columnWidth, metric, tableCaption);
    let expanded = expandRectToAvoidSoftCuts(trimmed, lines, graphics, bodyFontSize, columnWidth, metric, tableCaption);
    return tableCaption
        ? trimTableBottomProseChunks(expanded, lines, bodyFontSize, columnWidth, metric)
        : expanded;
}

function fitRectToGraphics(
    rect: PDF_Rect,
    captionLine: TextLine,
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    metric: PageMetrics,
    tableCaption: boolean
) {
    let searchRect = graphicSearchRect(captionLine, rect, tableCaption, columnWidth, metric);
    let allowedRect = expandRect(rect, 12, metric);
    let allowWideCluster = isWideFigureWidth(rect.width, columnWidth, metric) ||
        isWideFigureWidth(captionLine.width, columnWidth, metric);
    let relatedGraphics = graphics.filter((graphic) =>
        graphic.page == rect.page &&
        usefulGraphicObject(graphic, metric) &&
        rectsOverlap(graphic, searchRect) &&
        rectsOverlap(graphic, allowedRect)
    );
    let clusters = clusterGraphicRects(relatedGraphics, metric)
        .filter((cluster) => rectsOverlap(cluster.rect, searchRect))
        .filter((cluster) => rectsOverlap(cluster.rect, allowedRect))
        // 通常の 1 カラム図では、右カラム本文の glyph path などと結合した横長クラスタを採用しない。
        .filter((cluster) => allowWideCluster || cluster.rect.width <= allowedRect.width * 1.25)
        .filter((cluster) => rectArea(cluster.rect) >= 120 || cluster.count >= 3);

    let captionCenter = captionLine.x + captionLine.width / 2;
    let best: GraphicCluster | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let cluster of clusters) {
        let gap = tableCaption
            ? captionLine.y - rectTop(cluster.rect)
            : cluster.rect.y - (captionLine.y + captionLine.fontSize);
        if (gap < -captionLine.fontSize || gap > Math.max(300, metric.height * 0.45)) {
            continue;
        }

        let score =
            Math.sqrt(rectArea(cluster.rect)) +
            cluster.count * 8 -
            Math.max(0, gap) * 0.25 -
            Math.abs(rectCenterX(cluster.rect) - captionCenter) * 0.04;
        if (score > bestScore) {
            best = cluster;
            bestScore = score;
        }
    }

    if (!best) {
        return avoidBodyAndEdgeCuts(rect, lines, graphics, bodyFontSize, columnWidth, metric, tableCaption);
    }

    // 図中ラベルや表内テキストも、選ばれた描画クラスタの近くにあるものだけ bbox に含める。
    let fitted = best.rect;
    let textSearch = expandRect(best.rect, 18, metric);
    for (let line of lines) {
        if (
            line.page != rect.page ||
            isCaptionLine(line, bodyFontSize, columnWidth) ||
            isHeadingLine(line, bodyFontSize) ||
            isParagraphLikeLine(line, bodyFontSize, columnWidth) && line.fontSize >= bodyFontSize - 0.2 ||
            !tableCaption && isBodySizedProseFragment(line, bodyFontSize)
        ) {
            continue;
        }

        let candidate = lineRect(line);
        if (rectsOverlap(candidate, textSearch)) {
            fitted = unionRects(fitted, candidate);
        }
    }

    fitted = expandRect(fitted, 8, metric);
    if (tableCaption) {
        fitted = unionRects(fitted, rect);
        let top = Math.min(rectTop(fitted), captionLine.y - captionLine.fontSize * 0.25);
        let finalRect = {...fitted, height: Math.max(24, top - fitted.y)};
        return avoidBodyAndEdgeCuts(finalRect, lines, graphics, bodyFontSize, columnWidth, metric, tableCaption);
    }

    let y = Math.max(fitted.y, figureCaptionClearY(captionLine));
    let finalRect = {...fitted, y, height: Math.max(24, rectTop(fitted) - y)};
    return avoidBodyAndEdgeCuts(finalRect, lines, graphics, bodyFontSize, columnWidth, metric, tableCaption);
}

// Figure 内の軸ラベルや凡例は本文より小さいフォントで抽出されることが多い。
// その分布を使って、固定高さの crop が本文やタイトルを巻き込む場合を抑える。
function fitFigureRectToInnerText(rect: PDF_Rect, lines: TextLine[], bodyFontSize: number, columnWidth: number, metric: PageMetrics) {
    let top = rect.y + rect.height;
    let innerLines = lines.filter((line) =>
        line.page == rect.page &&
        line.y >= rect.y &&
        line.y <= top &&
        lineCenterHorizontallyInsideRect(line, rect, 12) &&
        line.fontSize < bodyFontSize - 0.8 &&
        line.text.length > 1
    );

    if (innerLines.length < 2) {
        return rect;
    }

    let pageMargin = 36;
    let minX = Math.min(...innerLines.map((line) => line.x));
    let maxX = Math.max(...innerLines.map((line) => line.x + line.width));
    let minY = Math.min(...innerLines.map((line) => line.y));
    let maxY = Math.max(...innerLines.map((line) => line.y + line.fontSize));
    if (maxY - minY < Math.max(bodyFontSize * 3, 30)) {
        return rect;
    }

    let expandableMinX = rect.x - minX < columnWidth * 0.75 ? minX : rect.x;
    let expandableMaxX = maxX - (rect.x + rect.width) < columnWidth * 0.75 ? maxX : rect.x + rect.width;
    let x = Math.min(rect.x, expandableMinX - 24);
    let right = Math.max(rect.x + rect.width, expandableMaxX + 24);
    let trimmedTop = Math.min(top, maxY + 18);
    let isWide = isWideFigureWidth(rect.width, columnWidth, metric);

    x = clamp(x, pageMargin, metric.width - pageMargin);
    right = clamp(right, x + 24, metric.width - pageMargin);
    if (!isWide && rect.x < metric.width / 2) {
        let rightColumnLeft = Math.max(metric.width / 2, metric.maxX - columnWidth);
        right = clamp(Math.min(right, rightColumnLeft - 8), x + 24, metric.width - pageMargin);
    }
    trimmedTop = clamp(trimmedTop, rect.y + 24, top);

    return {
        ...rect,
        x,
        width: right - x,
        height: trimmedTop - rect.y
    };
}

// Figure が縦に続くページでは、現在の Figure の上側候補に直前 Figure のキャプションが入ることがある。
// 候補内に別のキャプションを見つけたら、その直下で上端を切り、前の図を巻き込まないようにする。
function trimFigureRectAtPreviousCaption(rect: PDF_Rect, lines: TextLine[], bodyFontSize: number, columnWidth: number) {
    let top = rect.y + rect.height;
    let previousCaption = lines
        .filter((line) =>
            line.page == rect.page &&
            line.y > rect.y &&
            line.y < top &&
            lineCenterHorizontallyInsideRect(line, rect, 0) &&
            (isCaptionLine(line, bodyFontSize, columnWidth) || isAlgorithmCaptionLine(line))
        )
        .sort((a, b) => a.y - b.y)[0];

    if (!previousCaption) {
        return rect;
    }

    let captionBottom = previousCaption.y;
    let prevLine = previousCaption;
    let captionText = previousCaption.text;
    let possibleContinuationLines = lines
        .filter((line) =>
            line.page == rect.page &&
            line.y < previousCaption.y &&
            line.y > rect.y
        )
        .sort((a, b) => b.y - a.y);

    for (let line of possibleContinuationLines) {
        if (Math.abs(line.x - previousCaption.x) >= columnWidth * 0.6) {
            continue;
        }

        if (captionLooksComplete(captionText)) {
            break;
        }

        if (!isLikelyCaptionContinuationLine(previousCaption, prevLine, line, bodyFontSize, columnWidth)) {
            break;
        }

        captionText = appendLineText(captionText, line.text);
        captionBottom = line.y;
        prevLine = line;
    }

    // 複数行キャプションの続きも落とすため、キャプションブロックの少し下まで余白を取る。
    let trimmedTop = clamp(
        captionBottom - Math.max(bodyFontSize * 0.8, 8),
        rect.y + 24,
        top
    );

    return {
        ...rect,
        height: trimmedTop - rect.y
    };
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
        if (gap > gapLimit) {
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

// 読み順に並んだ行から、キャプションと図表・疑似コード領域を先に集める。
function collectFigureCandidates(
    lines: TextLine[],
    graphics: PDF_GraphicObject[],
    bodyFontSize: number,
    columnWidth: number,
    pageMetrics: Map<number, PageMetrics>
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
                node: new PDF_Node(
                    caption,
                    PDF_NodeType.FIGURE,
                    estimateAlgorithmRect(line, lines, i, bodyFontSize, columnWidth, metric) ?? undefined
                )
            });
            continue;
        }

        let captionLines = 1;
        while (!captionLooksComplete(caption) && captionLines < 20 && endIndex + 1 < lines.length) {
            let next = lines[endIndex + 1];
            let tableCaption = isTableCaption(caption);
            if (
                tableCaption &&
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
                !isLikelyCaptionContinuationLine(line, lines[endIndex], next, bodyFontSize, columnWidth)
            ) {
                break;
            }

            caption = appendLineText(caption, next.text);
            endIndex++;
            captionLines++;
        }

        let rect = estimateFigureRect(caption, line, columnWidth, metric);
        if (rect && isTableCaption(caption)) {
            let captionEndLine = lines[endIndex] ?? line;
            // Table はキャプションの下側を切り出すため、複数行キャプションでは最終行を境界にする。
            let tableBoundaryLine = {...line, y: captionEndLine.y, fontSize: captionEndLine.fontSize};
            rect = fitTableRectToInnerText(rect, lines, line, endIndex, bodyFontSize, columnWidth, metric) ??
                trimTableRectAtBodyText(rect, lines, endIndex, bodyFontSize, columnWidth);
            rect = fitRectToGraphics(rect, tableBoundaryLine, lines, graphics, bodyFontSize, columnWidth, metric, true);
        }
        else if (rect) {
            let fallbackRect = trimFigureRectAtPreviousCaption(rect, lines, bodyFontSize, columnWidth);
            rect = trimFigureRectAtPreviousCaption(rect, lines, bodyFontSize, columnWidth);
            rect = fitFigureRectToInnerText(rect, lines, bodyFontSize, columnWidth, metric);
            rect = fitRectToGraphics(rect, line, lines, graphics, bodyFontSize, columnWidth, metric, false);
            rect = trimFigureRectAtPreviousCaption(rect, lines, bodyFontSize, columnWidth);
            if ((rect.height < 36 || rect.width < 80) && rectArea(fallbackRect) > rectArea(rect)) {
                rect = fallbackRect;
            }
        }

        candidates.push({
            startIndex: i,
            endIndex,
            node: new PDF_Node(caption, PDF_NodeType.FIGURE, rect ?? undefined)
        });
    }

    return candidates;
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

function lineCenterHorizontallyInsideRect(line: TextLine, rect: PDF_Rect, margin: number) {
    if (line.page != rect.page) {
        return false;
    }

    let centerX = line.x + line.width / 2;
    return centerX >= rect.x - margin && centerX <= rect.x + rect.width + margin;
}

// 抽出の中心処理。ページごとの TextItem から、タイトル・見出し・本文・図表を作る。
export function extractNodesFromPages(pages: Array<unknown[] | PDF_PageInput>) {
    // TextItem をページごとの行へ復元し、文書全体の本文らしいサイズを推定する。
    let lines = pages.flatMap((page, index) => buildLinesForPage(pageItems(page), index + 1));
    let graphics = pages.flatMap((page) => pageGraphics(page));
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
    let pageColumnWidth = median(
        [...pageMetrics.values()]
            .map((metric) => (metric.maxX - metric.minX) / 2 - 8)
            .filter((width) => width > 120),
        240
    );
    let figureColumnWidth = Math.max(columnWidth, Math.min(pageColumnWidth, 280));

    // 行単位の前処理: 見出し分割とページ番号除去を行う。小さい図表内テキストは矩形推定で使うため残す。
    lines = splitHeadingLines(lines, bodyFontSize)
        .filter((line) => line.text != "")
        .filter((line) => !isPageDecoration(line));

    // 読み順にした行から Figure/Table を先に集め、後続の本文抽出で除外できる形にする。
    let readingLines = sortLinesForReading(lines);
    let figures = collectFigureCandidates(readingLines, graphics, bodyFontSize, figureColumnWidth, pageMetrics);
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

    let nodes: PDF_Node[] = [];
    let title = "";
    let paragraph = "";
    let prevTextLine: TextLine | null = null;

    // 複数行に分かれたタイトルを 1 つのノードにまとめる。
    function flushTitle() {
        if (title != "") {
            nodes.push(new PDF_Node(title, PDF_NodeType.TITLE));
            title = "";
        }
    }

    // 連結中の本文段落を確定する。
    function flushParagraph() {
        if (paragraph != "") {
            nodes.push(new PDF_Node(paragraph, PDF_NodeType.TEXT));
            paragraph = "";
        }
    }

    // キャプション行と図表矩形内の行を飛ばしながら、残りを構造ノードへ変換する。
    for (let i = 0; i < readingLines.length; i++) {
        let line = readingLines[i];
        let figure = figureByStart.get(i);
        if (figure) {
            flushTitle();
            flushParagraph();
            nodes.push(figure.node);
            prevTextLine = null;
            continue;
        }

        if (
            captionLineIndices.has(i) ||
            figureRects.some((rect) => lineCenterInsideRect(line, rect))
        ) {
            prevTextLine = null;
            continue;
        }

        if (shouldDropStructuralFragmentLine(line, bodyFontSize, columnWidth)) {
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
            prevTextLine = null;
        }
        else if (isHeadingLine(line, bodyFontSize)) {
            flushTitle();
            flushParagraph();
            nodes.push(new PDF_Node(line.text, PDF_NodeType.HEADING));
            prevTextLine = null;
        }
        else {
            flushTitle();
            if (shouldStartParagraph(line, prevTextLine, columnWidth, paragraph)) {
                flushParagraph();
            }
            paragraph = appendLineText(paragraph, line.text);
            prevTextLine = line;
        }
    }

    flushTitle();
    flushParagraph();
    return mergeAdjacentTextFragments(moveInterruptedFiguresAfterParagraphs(nodes));
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

// 構造ノード種別を HTML タグに対応づける。
export function nodeToHTMLElementName(node: PDF_Node) {
    switch (node.type) {
        case PDF_NodeType.TITLE:
            return "h1";
        case PDF_NodeType.HEADING:
            return headingHTMLElementName(node.str);
        case PDF_NodeType.CAPTION:
            return "figcaption";
        case PDF_NodeType.FIGURE:
            return "figure";
        default:
            return "p";
    }
}

// CLI 出力用の最小 HTML を生成する。
export function nodesToHTML(nodes: PDF_Node[]) {
    let body = nodes.map((node) => {
        if (node.type == PDF_NodeType.FIGURE) {
            let image = node.imageSrc
                ? `<img src="${escapeHTML(node.imageSrc)}" alt="${escapeHTML(node.str)}">`
                : "";
            return `<figure>${image}<figcaption>${escapeHTML(node.str)}</figcaption></figure>`;
        }

        let tag = nodeToHTMLElementName(node);
        return `<${tag}>${escapeHTML(node.str)}</${tag}>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        main { max-width: 760px; margin: 0 auto; line-height: 1.55; }
        figure { margin: 1.5rem 0; }
        figure img { display: block; max-width: 88%; height: auto; margin: 0 auto 0.5rem; }
        figcaption { font-size: 0.92rem; color: #333; text-align: center; }
    </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
