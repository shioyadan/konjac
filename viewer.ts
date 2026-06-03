"use strict";
import "./external_modules_src";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {PDF_Node, extractNodesFromTextItems, nodeToHTMLElementName} from "./extractor";

pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), {type: "module"});

console.log("initialized.");

function show(nodes: PDF_Node[]) {

    for (let node of nodes) {
        // @ts-ignore
        let text = document.createTextNode(node.str); // テキストノードを作成

        // @ts-ignore
        var div = document.createElement(nodeToHTMLElementName(node)); // p要素作成
        div.appendChild(text);
        // @ts-ignore
        document.getElementById("main").appendChild(div);
    }

}

function load(fileName: string) {
    let loadingTask = pdfjsLib.getDocument({
        url: fileName,
        cMapPacked: true,
        cMapUrl: "cmaps/"   // 日本語（や他の言語）を表示するために必要なマップファイル．Makefile で dist にコピーされる
    });

    loadingTask.promise.then(async (pdf) => {
        let nodes: PDF_Node[] = [];
        for (let pageNumber = 1; pageNumber < pdf.numPages + 1; pageNumber++) {
            let page = await pdf.getPage(pageNumber);
            let textContent = await page.getTextContent();
            nodes.push(...extractNodesFromTextItems(textContent.items));
        }
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

