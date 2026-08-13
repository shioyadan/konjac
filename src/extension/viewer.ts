"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {loadPDF} from "../core/viewer";
import {recentFileName, recentFiles, rememberRecentFile, renderRecentFileList} from "../core/recent_files";

pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), {type: "module"});

function renderRecentFiles() {
    renderRecentFileList((file) => {
        let viewerURL = new URL(location.href);
        viewerURL.search = "";
        viewerURL.searchParams.set("file", file.source ?? "");
        location.href = viewerURL.toString();
    }, recentFiles().filter((file) => file.source));
}

renderRecentFiles();
let targetURL = new URL(location.href).searchParams.get("file");
if (targetURL) {
    console.log(targetURL);
    loadPDF(targetURL).then(() => {
        rememberRecentFile({key: targetURL, name: recentFileName(targetURL), source: targetURL});
        renderRecentFiles();
    }).catch((error) => {
        console.error(error);
        let main = document.getElementById("main");
        let progress = document.getElementById("progress");
        if (progress) {
            progress.hidden = true;
        }
        if (main) {
            main.textContent = "Failed to load PDF.";
        }
    });
}
