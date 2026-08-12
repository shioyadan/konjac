"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {loadPDF} from "./viewer";

pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), {type: "module"});

let targetURL = new URL(location.href).searchParams.get("file");
if (targetURL) {
    console.log(targetURL);
    loadPDF(targetURL).catch((error) => {
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
