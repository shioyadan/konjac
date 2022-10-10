import "./node_modules/bootstrap/dist/css/bootstrap.min.css";
import "./node_modules/bootstrap/dist/js/bootstrap.bundle.js";

import pdfjsLib_ from "./node_modules/pdfjs-dist/build/pdf.js";
export let pdfjsLib = pdfjsLib_;

// @ts-ignore
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.js", import.meta.url));
