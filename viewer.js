"use strict";

// @ts-ignore
let pdfjsLib = external_modules.pdfjsLib;
console.log("initialized.");

const NODE_TYPE_TEXT = 1;
const NODE_TYPE_SECTION_TITLE = 2;

class Node {
    constructor(str, type) {
        this.str = str;
        this.type = type;
    }
};

/**
 * @param {Node[]} nodes 
 */
function show(nodes) {

    for (let node of nodes) {
        // @ts-ignore
        let text = document.createTextNode(node.str); // テキストノードを作成

        // @ts-ignore
        var div = document.createElement(node.type == NODE_TYPE_TEXT ? "p" : "h2"); // p要素作成
        div.appendChild(text);
        // @ts-ignore
        document.getElementById("main").appendChild(div);
    }

}
// タイトル中に小文字で出てきても良い単語
const TITLE_EXCEPTION_PATTERN = /^and|the|of|at|to|on|in|for|by|with|from|before|after|about|near|until|as|during|over|off|through|above|below|against|around|among|between|into|under|along|without|within|inside|beside$/;

/**
 * タイトルを検出
 * @param {string} line 
 */
function isTitle(line) {
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

function load(fileName) {
    /** @type {import("pdfjs-dist").PDFDocumentLoadingTask} */
    let loadingTask = pdfjsLib.getDocument(fileName);
    loadingTask.promise.then(async (pdf) => {
        let nodes = [];
        for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
            let page = await pdf.getPage(pageNumber);
            let textContent = await page.getTextContent();
            let prevStr = "";
            textContent.items.forEach(
                /**
                 * @param {import("pdfjs-dist/types/src/display/api").TextItem} textItem 
                 */
                (textItem) => {
                prevStr += (prevStr != "" && textItem.str != "" ? " " : "") + textItem.str;
                if (textItem.hasEOL) {
                    if (prevStr.match(/\.$/)) {
                        nodes.push(new Node(prevStr, NODE_TYPE_TEXT));
                        prevStr = "";
                    }
                    else if (isTitle(prevStr)) {
                        nodes.push(new Node(prevStr, NODE_TYPE_SECTION_TITLE));
                        prevStr = "";
                    }
                }
            });
        }
        show(nodes);
    });
}


// アクティブなタブの URL を取得して使う
chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    let url = tabs[0].url;
    // file= にローカルにダウンロードした PDF の URL が埋め込まれているので，それをロードする
    if (url.match(/\?file=(.+)$/)) {
        let targetURL = decodeURIComponent(RegExp.$1);
        console.log(targetURL);
        load(targetURL);        
    }
});



// console.log(import.meta.url);

