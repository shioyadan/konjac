declare module "*.css" {
    const content: string;
    export default content;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
    const PDFWorker: {new (): Worker};
    export default PDFWorker;
}
