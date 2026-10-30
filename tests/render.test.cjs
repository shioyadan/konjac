const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createCanvas, loadImage} = require('canvas');
const ts = require('typescript');
const engine = {};
new Function('exports', ts.transpileModule(readFileSync('src/core/render.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText)(engine);
const {renderPageCanvas, cropRectFromPage, attachNodeImages} = engine;
const rect = {page: 1, x: 10, y: 30, width: 20, height: 10};
function page() {
    return {
        renders: 0,
        getViewport: ({scale}) => ({width: 80 * scale, height: 100 * scale, scale}),
        render({canvasContext, viewport: {scale}}) {
            this.renders++;
            canvasContext.fillStyle = 'red';
            canvasContext.fillRect(10 * scale, 60 * scale, 20 * scale, 10 * scale);
            return {promise: Promise.resolve()};
        }
    };
}
async function decoded(src) {
    const image = await loadImage(src), canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
}

test('page previews preserve the requested scale and a white background', async () => {
    const rendered = await renderPageCanvas(page(), createCanvas, 2);
    assert.deepEqual([rendered.canvas.width, rendered.canvas.height, rendered.pageHeight, rendered.scale], [160, 200, 100, 2]);
    const ctx = rendered.canvas.getContext('2d');
    assert.deepEqual([...ctx.getImageData(21, 121, 1, 1).data], [255, 0, 0, 255]);
    assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [255, 255, 255, 255]);
});

test('PDF crops use a bottom-left origin and clip at the page edge', async () => {
    const rendered = await renderPageCanvas(page(), createCanvas);
    const crop = await decoded(cropRectFromPage(rendered, rect, createCanvas));
    assert.deepEqual([crop.width, crop.height], [80, 40]);
    assert.deepEqual([...crop.getContext('2d').getImageData(40, 20, 1, 1).data], [255, 0, 0, 255]);
    const edge = await decoded(cropRectFromPage(rendered, {...rect, x: 75}, createCanvas));
    assert.deepEqual([edge.width, edge.height], [20, 40]);
    assert.equal(cropRectFromPage(rendered, {...rect, x: 90}, createCanvas), '');
});

test('block and inline images reuse one page rendering and skip missing pages', async () => {
    const source = page();
    const nodes = [
        {type: 5, str: 'Figure 1.', rect}, {type: 6, str: '(1)', rect}, {type: 9, str: 'code', rect},
        {type: 1, str: 'inline', inlineImages: [{rect}]},
        {type: 5, str: 'missing', rect: {...rect, page: 2}}
    ];
    await attachNodeImages(nodes, [source], createCanvas);
    assert.equal(source.renders, 1);
    assert.match(nodes[0].imageSrc, /^data:image\/png;base64,/);
    for (const node of nodes.slice(1, 3)) assert.equal(node.imageSrc, nodes[0].imageSrc);
    assert.equal(nodes[3].inlineImages[0].imageSrc, nodes[0].imageSrc);
    assert.equal(nodes[4].imageSrc, undefined);
});

test('an unavailable canvas context leaves images unset', async () => {
    const unavailable = (width, height) => ({width, height, getContext: () => null});
    const source = page(), nodes = [{rect}, {rect}];
    await attachNodeImages(nodes, [source], unavailable);
    assert.equal(source.renders, 0);
    assert.ok(nodes.every((node) => node.imageSrc === undefined));
    const rendered = await renderPageCanvas(source, createCanvas);
    assert.equal(cropRectFromPage(rendered, rect, unavailable), '');
});
