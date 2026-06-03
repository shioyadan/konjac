"use strict";

// PDF.js の TextItem 群から論文らしい HTML 構造を推定する軽量な抽出器。
// 処理の流れ:
//   1. TextItem を座標付き TextPart に正規化する。
//   2. y 座標と x 座標から TextLine を復元する。
//   3. 文書全体から本文フォントサイズと本文幅を推定する。
//   4. ページ番号などの一般的な装飾を落とし、読み順を 2 段組み前提で整える。
//   5. フォントサイズと文字列パターンから title/heading/caption/text に分類する。
//   6. 連続する本文行を段落にまとめ、HTML タグへ対応づける。

export enum PDF_NodeType {
    // 通常の本文段落。
    TEXT = 1,
    // 論文タイトル。
    TITLE = 2,
    // ABSTRACT や章・節見出し。
    HEADING = 3,
    // Figure/Table のキャプション。
    CAPTION = 4
};

// HTML に変換する前の構造ノード。
export class PDF_Node {
    // ノード内のプレーンテキスト。
    str: string;
    // 本文、タイトル、見出し、キャプションの種別。
    type: PDF_NodeType;

    constructor(str: string, type: PDF_NodeType) {
        this.str = str;
        this.type = type;
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

// ページ番号など、論文本体ではない固定要素を落とす。
function isPageDecoration(line: TextLine) {
    return /^\d+$/.test(line.text) && line.fontSize <= 12;
}

// 図表キャプションの先頭行を検出する。
function isCaptionLine(line: TextLine) {
    return /^(?:Figure|Table)\s+\d+\s*[:.]/.test(line.text);
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

// 抽出の中心処理。ページごとの TextItem から、タイトル・見出し・本文・キャプションを作る。
export function extractNodesFromPages(pages: unknown[][]) {
    let lines = pages.flatMap((textItems, index) => buildLinesForPage(textItems, index + 1));
    let bodyFontSize = estimateBodyFontSize(lines);

    // 本文幅の代表値を使って、カラム移動や短い行による段落切れを判定する。
    let columnWidth = median(
        lines
            .filter((line) => Math.abs(line.fontSize - bodyFontSize) < 0.5 && line.width > 100)
            .map((line) => line.width),
        240
    );

    // 行単位の前処理: 見出し分割、ページ番号除去、本文サイズから外れすぎた行の除外。
    lines = splitHeadingLines(lines, bodyFontSize)
        .filter((line) => line.text != "")
        .filter((line) => !isPageDecoration(line))
        .filter((line) => line.fontSize >= bodyFontSize - 1.2 || isCaptionLine(line) || isHeadingLine(line, bodyFontSize));

    let nodes: PDF_Node[] = [];
    let title = "";
    let caption = "";
    let captionLines = 0;
    let paragraph = "";
    let prevTextLine: TextLine | null = null;

    // 複数行に分かれたタイトルを 1 つのノードにまとめる。
    function flushTitle() {
        if (title != "") {
            nodes.push(new PDF_Node(title, PDF_NodeType.TITLE));
            title = "";
        }
    }

    // 複数行キャプションを 1 つの figcaption にまとめる。
    function flushCaption() {
        if (caption != "") {
            nodes.push(new PDF_Node(caption, PDF_NodeType.CAPTION));
            caption = "";
            captionLines = 0;
        }
    }

    // 連結中の本文段落を確定する。
    function flushParagraph() {
        if (paragraph != "") {
            nodes.push(new PDF_Node(paragraph, PDF_NodeType.TEXT));
            paragraph = "";
        }
    }

    // 読み順に並べ直した行を、順に構造ノードへ変換する。
    for (let line of sortLinesForReading(lines)) {
        if (isTitleLine(line, bodyFontSize)) {
            flushParagraph();
            flushCaption();
            title = appendLineText(title, line.text);
            prevTextLine = null;
        }
        else if (isHeadingLine(line, bodyFontSize)) {
            flushTitle();
            flushParagraph();
            flushCaption();
            nodes.push(new PDF_Node(line.text, PDF_NodeType.HEADING));
            prevTextLine = null;
        }
        else if (isCaptionLine(line)) {
            flushTitle();
            flushParagraph();
            flushCaption();
            caption = line.text;
            captionLines = 1;
            if (/[.!?)]$/.test(caption)) {
                flushCaption();
            }
            prevTextLine = null;
        }
        else if (caption != "") {
            caption = appendLineText(caption, line.text);
            captionLines++;
            if (/[.!?)]$/.test(caption) || captionLines >= 20) {
                flushCaption();
            }
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
    flushCaption();
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
        default:
            return "p";
    }
}

// CLI 出力用の最小 HTML を生成する。
export function nodesToHTML(nodes: PDF_Node[]) {
    let body = nodes.map((node) => {
        let tag = nodeToHTMLElementName(node);
        return `<${tag}>${escapeHTML(node.str)}</${tag}>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
