declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
    const PDFWorker: {new (): Worker};
    export default PDFWorker;
}

declare module "*.wasm" {
    const url: string;
    export default url;
}
