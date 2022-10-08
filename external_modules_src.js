import pdfjsLib_ from "./node_modules/pdfjs-dist/build/pdf.js";
export let pdfjsLib = pdfjsLib_;

pdfjsLib.GlobalWorkerOptions.workerPort =
    // @ts-ignore
    new Worker(new URL("pdfjs-dist/build/pdf.worker.js", import.meta.url));
