"use strict";

// @ts-ignore
let pdfjsLib = external_modules.pdfjsLib;
console.log("initialized.");


const fileName = "work/test.pdf"

function load(fileName) {
    let loadingTask = pdfjsLib.getDocument(fileName);
    loadingTask.promise.then((pdf) => {
        // Fetch the first page
        let pageNumber = 1;
        pdf.getPage(pageNumber).then((page) => {
            page.getTextContent().then((textContent) => {
                textContent.items.forEach((textItem) => {
                    //console.log(textItem.str);
                    document.getElementById("main").textContent += textItem.str;
                })
            });
        });
    });
}

// load(fileName);

chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    let url = tabs[0].url;
    if (url.match(/\?file=(.+)$/)) {
        let targetURL = decodeURIComponent(RegExp.$1);
        console.log(targetURL);
        load(targetURL);        
    }
});



// console.log(import.meta.url);

