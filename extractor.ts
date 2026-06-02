"use strict";

export enum PDF_NodeType {
    TEXT = 1,
    TITLE = 2
};

export class PDF_Node {
    str: string;
    type: PDF_NodeType;

    constructor(str: string, type: PDF_NodeType) {
        this.str = str;
        this.type = type;
    }
};

export interface PDF_TextItemLike {
    str?: string;
    hasEOL?: boolean;
};

// タイトル中に小文字で出てきても良い単語
const TITLE_EXCEPTION_PATTERN = /^(?:and|the|of|at|to|on|in|for|by|with|from|before|after|about|near|until|as|during|over|off|through|above|below|against|around|among|between|into|under|along|without|within|inside|beside)$/;

/**
 * タイトルを検出
 */
export function isTitle(line: string) {
    // ピリオドがなく，単語が全部大文字始まりの行はタイトルとみなす
    let title = false;
    if (!line.match(/\.$/)) {
        // ピリオドでおわっていない
        title = true;

        // 単語の頭が大文字じゃないかを検査
        // ただし前置詞や the は小文字でもよいとする
        let tokens = line.split(" ");
        for (let t of tokens) {
            if (!t.match(/^[A-Z0-9]/) && !t.match(TITLE_EXCEPTION_PATTERN)) {
                title = false;
                break;
            }
        }
    }

    return title;
}

export function extractNodesFromTextItems(textItems: unknown[]) {
    let nodes: PDF_Node[] = [];
    let prevStr = "";

    for (let textItemArg of textItems) {
        let textItem = textItemArg as PDF_TextItemLike;
        if (typeof textItem.str != "string") {
            continue;
        }

        prevStr += (prevStr != "" && textItem.str != "" ? " " : "") + textItem.str;
        if (textItem.hasEOL) {
            if (prevStr.match(/[．。\.]$/)) {
                nodes.push(new PDF_Node(prevStr, PDF_NodeType.TEXT));
                prevStr = "";
            }
            else if (isTitle(prevStr)) {
                nodes.push(new PDF_Node(prevStr, PDF_NodeType.TITLE));
                prevStr = "";
            }
        }
    }

    if (prevStr != "") {
        nodes.push(new PDF_Node(prevStr, PDF_NodeType.TEXT));
    }

    return nodes;
}

function escapeHTML(str: string) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function nodeToHTMLElementName(node: PDF_Node) {
    return node.type == PDF_NodeType.TEXT ? "p" : "h2";
}

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
