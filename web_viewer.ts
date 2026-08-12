"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import PDFWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import {EmbeddedCMapReaderFactory} from "./embedded_cmaps";
import {loadPDF} from "./viewer";

pdfjsLib.GlobalWorkerOptions.workerPort = new PDFWorker();

const WEB_PDF_OPTIONS = {CMapReaderFactory: EmbeddedCMapReaderFactory};

let fileInput = document.getElementById("pdf-file");
let dropZone = document.getElementById("pdf-drop-zone");
let status = document.getElementById("web-status");

function setStatus(message: string, error = false) {
    if (status) {
        status.textContent = message;
        status.classList.toggle("error", error);
    }
}

async function openLocalPDF(file: File | undefined) {
    if (!file) {
        return;
    }
    if (file.type != "application/pdf" && !/\.pdf$/i.test(file.name)) {
        setStatus("Please choose a PDF file.", true);
        return;
    }

    setStatus(`Opening ${file.name}…`);
    let fileURL = URL.createObjectURL(file);
    try {
        await loadPDF(fileURL, file.name, WEB_PDF_OPTIONS);
        setStatus("");
    }
    catch (error) {
        console.error(error);
        let progress = document.getElementById("progress");
        if (progress) {
            progress.hidden = true;
        }
        let detail = error instanceof Error ? ` ${error.message}` : "";
        setStatus(`Failed to load PDF.${detail}`, true);
    }
    finally {
        URL.revokeObjectURL(fileURL);
    }
}

if (fileInput instanceof HTMLInputElement) {
    fileInput.onchange = () => void openLocalPDF(fileInput.files?.[0]);
}

if (dropZone) {
    dropZone.ondragover = (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
        }
        dropZone.classList.add("dragging");
    };
    dropZone.ondragleave = () => dropZone.classList.remove("dragging");
    dropZone.ondrop = (event) => {
        event.preventDefault();
        dropZone.classList.remove("dragging");
        void openLocalPDF(event.dataTransfer?.files[0]);
    };
}
