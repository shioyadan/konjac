"use strict";

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import PDFWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import {EmbeddedCMapReaderFactory} from "./embedded_cmaps";
import {loadPDF} from "../core/viewer";
import {renderRecentFileList} from "../core/recent_files";
import {
    loadRecentFileHandles,
    pickPDFFileHandle,
    readRecentFile,
    rememberRecentFileHandle,
    removeRecentFileHandle,
    supportsPersistentFileHistory,
    supportsPersistentFilePicker,
    type RecentFileHandle
} from "./recent_file_handles";

pdfjsLib.GlobalWorkerOptions.workerPort = new PDFWorker();

const WEB_PDF_OPTIONS = {CMapReaderFactory: EmbeddedCMapReaderFactory};

let fileInput = document.getElementById("pdf-file");
let dropZone = document.getElementById("pdf-drop-zone");
let sourceControls = document.getElementById("pdf-source-controls");
let status = document.getElementById("web-status");
let openingPDF = false;

async function renderRecentFiles(files?: readonly RecentFileHandle[]) {
    if (!supportsPersistentFileHistory()) {
        renderRecentFileList(() => undefined, []);
        return;
    }
    try {
        renderRecentFileList((file) => void openRecentPDF(file), files ?? await loadRecentFileHandles());
    }
    catch (error) {
        console.warn("Failed to load recent files", error);
        renderRecentFileList(() => undefined, []);
    }
}

function setStatus(message: string, error = false) {
    if (status) {
        status.textContent = message;
        status.classList.toggle("error", error);
    }
}

function setOpening(opening: boolean) {
    openingPDF = opening;
    document.querySelectorAll<HTMLButtonElement>("#recent-file-list button")
        .forEach((button) => button.disabled = opening);
}

async function openLocalPDF(file: File | undefined, handle?: FileSystemFileHandle) {
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
        if (handle && supportsPersistentFileHistory()) {
            void rememberRecentFileHandle(handle)
                .then((files) => renderRecentFiles(files))
                .catch((error) => console.warn("Failed to remember recent file", error));
        }
        setStatus("");
        if (sourceControls) {
            sourceControls.hidden = true;
        }
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

async function openPersistentPDF() {
    if (openingPDF) {
        return;
    }
    setOpening(true);
    try {
        let handle = await pickPDFFileHandle();
        if (handle) {
            await openLocalPDF(await handle.getFile(), handle);
        }
    }
    catch (error) {
        if (!(error instanceof DOMException && error.name == "AbortError")) {
            console.error(error);
            setStatus(`Could not open the file. ${error instanceof Error ? error.message : String(error)}`, true);
        }
    }
    finally {
        setOpening(false);
    }
}

async function openRecentPDF(record: RecentFileHandle) {
    if (openingPDF) {
        return;
    }
    setOpening(true);
    setStatus(`Requesting access to ${record.name}…`);
    try {
        let file = await readRecentFile(
            record.handle,
            () => setStatus(`Waiting for permission to access ${record.name}…`)
        );
        await openLocalPDF(file, record.handle);
    }
    catch (error) {
        if (error instanceof DOMException && error.name == "NotFoundError") {
            await removeRecentFileHandle(record.key);
            await renderRecentFiles();
        }
        setStatus(error instanceof Error ? error.message : `Could not reopen ${record.name}.`, true);
    }
    finally {
        setOpening(false);
    }
}

void renderRecentFiles();
if (!supportsPersistentFileHistory() && location.hostname == "wsl.localhost") {
    setStatus("Recent files require Konjac Web, localhost, or a Windows file path when opened from WSL.");
}

if (fileInput instanceof HTMLInputElement) {
    fileInput.onchange = () => void openLocalPDF(fileInput.files?.[0]);
}

if (dropZone) {
    if (supportsPersistentFilePicker()) {
        dropZone.onclick = (event) => {
            if (event.target != fileInput) {
                event.preventDefault();
                void openPersistentPDF();
            }
        };
    }
    dropZone.onkeydown = (event) => {
        if ((event.key == "Enter" || event.key == " ") && fileInput instanceof HTMLInputElement) {
            event.preventDefault();
            if (supportsPersistentFilePicker()) {
                void openPersistentPDF();
            }
            else {
                fileInput.click();
            }
        }
    };
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
