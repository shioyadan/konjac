"use strict";

// PDF.js の TextItem 群から論文らしい HTML 構造を推定する軽量な抽出器。
// 処理の流れ:
//   1. TextItem を座標付き TextPart に正規化する。
//   2. y 座標と x 座標から TextLine を復元する。
//   3. 文書全体から本文フォントサイズと本文幅を推定する。
//   4. ページ番号などの一般的な装飾を落とし、読み順を 2 段組み前提で整える。
//   5. Figure/Table キャプションから図表領域を粗く推定し、その領域内の文字行を本文から外す。
//   6. フォントサイズと文字列パターンから title/heading/figure/text に分類する。
//   7. 連続する本文行を段落にまとめ、HTML タグへ対応づける。

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

// 1 ページ分の入力。既存 API 互換のため unknown[] だけを渡すこともできる。
export interface PDF_PageInput {
    // PDF.js の getTextContent().items。
    items: unknown[];
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

// 同じ行とみなす y 座標差の許容値。
const LINE_Y_EPSILON = 2.0;
// 同一 y 座標上で別行・別カラムとみなす横方向の隙間。
const COLUMN_GAP = 14.0;

// PDF.js の transform から文字列、座標、フォントサイズを取り出す。
function textItemToPart(textItemArg: unknown, page: number) {
    let textItem = textItemArg as PDF_TextItemLike;
    if (typeof textItem.str != "string" || textItem.str == "") {
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

// 図表キャプションの先頭行を検出する。
function isCaptionLine(line: TextLine) {
    return /^(?:Figure|Table)\s+\d+\s*[:.]/.test(line.text);
}

function isTableCaption(text: string) {
    return /^Table\s+\d+\s*[:.]/.test(text);
}

// 1 ページ目で本文より十分大きい行を論文タイトル候補とする。
function isTitleLine(line: TextLine, bodyFontSize: number) {
    return line.page == 1 && line.fontSize >= bodyFontSize + 5;
}

// 1., 2.1, 2.2.3 などの章・節番号付き見出しだけを拾う。
function isNumberedSectionHeading(text: string) {
    return (
        /^\d+(?:\.\d+)+\s+[A-Za-z]/.test(text) ||
        /^\d+\.\s+[A-Z0-9][A-Z0-9 .&()/\-]+$/.test(text)
    );
}

function isHeadingText(text: string) {
    return (
        text == "ABSTRACT" ||
        isNumberedSectionHeading(text)
    );
}

// フォントサイズと文字列パターンから見出し行を判定する。
function isHeadingLine(line: TextLine, bodyFontSize: number) {
    if (isTitleLine(line, bodyFontSize)) {
        return false;
    }

    if (line.text == "ABSTRACT") {
        return true;
    }

    if (isNumberedSectionHeading(line.text)) {
        return line.fontSize >= bodyFontSize + 0.8 || line.text.length < 100;
    }

    return (
        line.fontSize >= bodyFontSize + 1.5 &&
        !/^\d/.test(line.text) &&
        !/[$+]/.test(line.text) &&
        /^[A-Z][A-Z0-9 .&()/\-]+$/.test(line.text)
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
                part.fontSize <= bodyFontSize + 0.3
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

function captionLooksComplete(caption: string) {
    return /[.!?)]$/.test(caption);
}

function clamp(value: number, minValue: number, maxValue: number) {
    return Math.max(minValue, Math.min(value, maxValue));
}

// キャプション行を基準に、Figure は上側、Table は下側を図表領域として切り出す。
// これは一般的な論文レイアウト向けの経験則で、個別 PDF 固有の文字列には依存しない。
function estimateFigureRect(caption: string, line: TextLine, columnWidth: number, metric: PageMetrics) {
    let pageMargin = 36;
    let padding = Math.max(6, line.fontSize * 0.8);
    let isWide = line.width > columnWidth * 1.25 || line.width > metric.width * 0.48;
    let rightColumnLeft = Math.max(metric.width / 2, metric.maxX - columnWidth);
    let columnLeft = line.x >= metric.width / 2 ? rightColumnLeft : metric.minX;
    let captionX = Math.max(pageMargin, line.x - 4);
    let columnX = Math.max(pageMargin, columnLeft - 4);
    let maxColumnSnap = Math.min(columnWidth * 0.25, 48);
    let x = isWide
        ? Math.max(pageMargin, metric.minX - 4)
        : Math.min(captionX, Math.max(columnX, captionX - maxColumnSnap));
    let width = isWide
        ? Math.min(metric.width - x - pageMargin, Math.max(metric.maxX - x + 4, line.width + padding * 2))
        : Math.min(metric.width - x - pageMargin, Math.max(columnWidth + padding, line.width + padding * 2));

    let heightLimit = isTableCaption(caption)
        ? Math.min(metric.height * 0.14, 95)
        : Math.min(metric.height * 0.34, 240);
    let y = 0;
    let height = 0;

    if (isTableCaption(caption)) {
        let top = line.y - line.fontSize - padding;
        height = Math.min(heightLimit, Math.max(0, top - pageMargin));
        y = top - height;
    }
    else {
        let figureGap = Math.max(2, line.fontSize * 0.25);
        y = line.y + line.fontSize + figureGap;
        height = Math.min(heightLimit, Math.max(0, metric.height - pageMargin - y));
    }

    x = clamp(x, 0, metric.width);
    y = clamp(y, 0, metric.height);
    width = clamp(width, 0, metric.width - x);
    height = clamp(height, 0, metric.height - y);

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

function isLetteredSectionHeading(text: string) {
    return /^[A-Z]\.\s+[A-Z0-9]/.test(text);
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

// Figure 内の軸ラベルや凡例は本文より小さいフォントで抽出されることが多い。
// その分布を使って、固定高さの crop が本文やタイトルを巻き込む場合を抑える。
function fitFigureRectToInnerText(rect: PDF_Rect, lines: TextLine[], bodyFontSize: number, columnWidth: number, metric: PageMetrics) {
    let top = rect.y + rect.height;
    let innerLines = lines.filter((line) =>
        line.page == rect.page &&
        line.y >= rect.y &&
        line.y <= top &&
        line.fontSize < bodyFontSize - 0.8 &&
        line.text.length > 1
    );

    if (innerLines.length < 2) {
        return rect;
    }

    let pageMargin = 36;
    let minX = Math.min(...innerLines.map((line) => line.x));
    let maxX = Math.max(...innerLines.map((line) => line.x + line.width));
    let maxY = Math.max(...innerLines.map((line) => line.y + line.fontSize));
    let expandableMinX = rect.x - minX < columnWidth * 0.75 ? minX : rect.x;
    let expandableMaxX = maxX - (rect.x + rect.width) < columnWidth * 0.75 ? maxX : rect.x + rect.width;
    let x = Math.min(rect.x, expandableMinX - 24);
    let right = Math.max(rect.x + rect.width, expandableMaxX + 24);
    let trimmedTop = Math.min(top, maxY + 18);

    x = clamp(x, pageMargin, metric.width - pageMargin);
    right = clamp(right, x + 24, metric.width - pageMargin);
    trimmedTop = clamp(trimmedTop, rect.y + 24, top);

    return {
        ...rect,
        x,
        width: right - x,
        height: trimmedTop - rect.y
    };
}

// 読み順に並んだ行から、キャプションと図表領域を先に集める。
function collectFigureCandidates(lines: TextLine[], bodyFontSize: number, columnWidth: number, pageMetrics: Map<number, PageMetrics>) {
    let candidates: FigureCandidate[] = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (!isCaptionLine(line)) {
            continue;
        }

        let caption = line.text;
        let endIndex = i;
        let captionLines = 1;
        while (!captionLooksComplete(caption) && captionLines < 20 && endIndex + 1 < lines.length) {
            let next = lines[endIndex + 1];
            if (
                isCaptionLine(next) ||
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

        let metric = pageMetrics.get(line.page);
        if (!metric) {
            continue;
        }

        let rect = estimateFigureRect(caption, line, columnWidth, metric);
        if (rect && isTableCaption(caption)) {
            rect = trimTableRectAtBodyText(rect, lines, endIndex, bodyFontSize, columnWidth);
        }
        else if (rect) {
            rect = fitFigureRectToInnerText(rect, lines, bodyFontSize, columnWidth, metric);
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

// 抽出の中心処理。ページごとの TextItem から、タイトル・見出し・本文・図表を作る。
export function extractNodesFromPages(pages: Array<unknown[] | PDF_PageInput>) {
    // TextItem をページごとの行へ復元し、文書全体の本文らしいサイズを推定する。
    let lines = pages.flatMap((page, index) => buildLinesForPage(pageItems(page), index + 1));
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

    // 行単位の前処理: 見出し分割、ページ番号除去、本文サイズから外れすぎた行の除外。
    lines = splitHeadingLines(lines, bodyFontSize)
        .filter((line) => line.text != "")
        .filter((line) => !isPageDecoration(line))
        .filter((line) => line.fontSize >= bodyFontSize - 1.2 || isCaptionLine(line) || isHeadingLine(line, bodyFontSize));

    // 読み順にした行から Figure/Table を先に集め、後続の本文抽出で除外できる形にする。
    let readingLines = sortLinesForReading(lines);
    let figures = collectFigureCandidates(readingLines, bodyFontSize, columnWidth, pageMetrics);
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
    return nodes;
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
            return "h2";
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
        figcaption { font-size: 0.92rem; color: #333; }
    </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
