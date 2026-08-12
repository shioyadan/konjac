"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;

const fileName = "work/test.pdf"

/** @param {string} fileName */
function load(fileName) {
    let loadingTask = pdfjsLib.getDocument(fileName);
    loadingTask.promise.then((pdf) => {
        // Fetch the first page
        let pageNumber = 1;
        pdf.getPage(pageNumber).then((page) => {
            page.getTextContent().then((textContent) => {
                textContent.items.forEach((textItem) => {
                    if ("str" in textItem) {
                        console.log(textItem.str);
                    }
                })
            });
        });
    });
}

load(fileName);
