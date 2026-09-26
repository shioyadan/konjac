const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync('src/core/extractor.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
});
const engine = {exports: {}};
new Function('exports', compiled.outputText)(engine.exports);
const {extractNodesFromPages, extractPageInputFromPDFPage} = engine.exports;
const text = (str, x, y, width = 240, size = 10) => ({str, width, transform: [size, 0, 0, size, x, y]});
const shape = (x, y, width, height) => ({page: 2, kind: 'path', x, y, width, height, strokeWidth: 1});
const paragraph = (x, y) => [0, 14, 28].map((dy) => text('Ordinary prose describes the experimental results in this section.', x, y - dy));
function extract(items, graphics = []) {
    return extractNodesFromPages([
        {width: 600, height: 800, items: paragraph(40, 700)},
        {width: 600, height: 800, items, graphics}
    ]);
}
const figures = (nodes) => nodes.filter((node) => node.type === 5);
const equations = (nodes) => nodes.filter((node) => node.type === 6);
const top = (r) => r.y + r.height;
const right = (r) => r.x + r.width;
const encloses = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && right(outer) >= right(inner) && top(outer) >= top(inner);

test('stacked panels stay together and stop at the body block', () => {
    const panels = [shape(55, 410, 210, 90), shape(55, 535, 210, 90)];
    const nodes = extract([...paragraph(40, 710), ...paragraph(40, 330), text('Figure 1. Two panels.', 40, 375, 220, 9)], panels);
    const [figure] = figures(nodes);
    for (const panel of panels) assert.ok(encloses(figure.rect, panel));
    assert.ok(top(figure.rect) < 680);
});

test('adjacent captions own separate figures', () => {
    const panels = [shape(50, 430, 210, 180), shape(330, 430, 210, 180)];
    const nodes = extract([...paragraph(40, 710), ...paragraph(320, 710), ...paragraph(40, 330), ...paragraph(320, 330),
        text('Figure 1. Left panel.', 40, 390, 230, 9), text('Figure 2. Right panel.', 320, 390, 230, 9)], panels);
    const [a, b] = figures(nodes);
    assert.ok(encloses(a.rect, panels[0]));
    assert.ok(encloses(b.rect, panels[1]));
    assert.ok(right(a.rect) <= b.rect.x);
});

test('a drawing overlapping body text cannot disable the body boundary', () => {
    const nodes = extract([...paragraph(40, 700), ...paragraph(40, 330), text('Figure 1. Diagram.', 40, 390, 210, 9)], [shape(55, 430, 210, 300)]);
    const [figure] = figures(nodes);
    assert.ok(figure.rect);
    assert.ok(top(figure.rect) < 670);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('Ordinary prose')));
});

test('a table above a figure keeps its own content', () => {
    const table = shape(50, 570, 210, 80), panel = shape(50, 430, 210, 100);
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 330), text('Table 1. Measurements.', 40, 680, 230, 9),
        text('Figure 1. Diagram.', 40, 390, 230, 9)], [table, panel]);
    const [a, b] = figures(nodes);
    assert.ok(encloses(a.rect, table));
    assert.ok(encloses(b.rect, panel));
    assert.ok(top(b.rect) <= a.rect.y);
});

test('adjacent numbered equations do not merge', () => {
    const nodes = extract([...paragraph(40, 730), ...paragraph(40, 590),
        text('x = a + b', 100, 665, 100), text('(1)', 265, 665, 15),
        text('y = c + d', 100, 630, 100), text('(2)', 265, 630, 15)]);
    const eq = equations(nodes);
    assert.equal(eq.length, 2);
    assert.ok(eq.every((node) => !(/\(1\)/.test(node.str) && /\(2\)/.test(node.str))));
    assert.ok(eq[0].rect.y >= top(eq[1].rect));
});

test('a tall equation is not limited to a fixed distance from its number', () => {
    const items = Array.from({length: 9}, (_, i) => text(`x${i} = a + b`, 100, 675 - i * 14, 120));
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 520), ...items, text('(1)', 265, 563, 15)]);
    const [eq] = equations(nodes);
    assert.ok(eq);
    assert.ok(eq.str.includes('x0') && eq.str.includes('x8'));
    assert.ok(top(eq.rect) >= 685 && eq.rect.y < 563);
});

test('unnumbered display math is recovered, inline prose and lists are preserved', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('x = a + b', 100, 660, 120),
        text('The equation x = a + b describes the result in the ordinary prose.', 40, 610),
        text('• x = a + b', 60, 585, 130)]);
    const eq = equations(nodes);
    assert.equal(eq.length, 1);
    assert.ok(eq[0].str.includes('x = a + b'));
    assert.ok(!eq[0].str.includes('ordinary prose'));
});

test('zero in a case expression and fraction rules remain inside the equation', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('f = x / y', 100, 660, 110), text('0', 180, 645, 8), text('(1)', 265, 655, 15)],
        [shape(175, 650, 40, 1)]);
    const [eq] = equations(nodes);
    assert.ok(eq.str.includes('0'));
    assert.ok(right(eq.rect) >= 215 && eq.rect.y <= 645);
});

test('CropBox translation is applied to both text and drawings', async () => {
    const page = {
        getViewport: () => ({width: 594, height: 774, transform: [1, 0, 0, -1, -36, 810]}),
        getTextContent: async () => ({items: [text('sample', 70, 100, 30)]}),
        getOperatorList: async () => ({fnArray: [1, 2], argsArray: [[[0], [70, 100, 90, 120], [70, 100, 90, 120]], []]})
    };
    const result = await extractPageInputFromPDFPage(page, 1, {constructPath: 1, fill: 2});
    assert.equal(result.items[0].transform[4], 34);
    assert.equal(result.items[0].transform[5], 64);
    assert.ok(Math.abs(result.graphics[0].x - 33.5) < .01);
    assert.ok(Math.abs(result.graphics[0].y - 63.5) < .01);
});

test('rotated page coordinates agree with the rendering viewport', async () => {
    const page = {
        getViewport: () => ({width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0]}),
        getTextContent: async () => ({items: [text('sample', 40, 100, 30)]}),
        getOperatorList: async () => ({fnArray: [], argsArray: []})
    };
    const result = await extractPageInputFromPDFPage(page, 1, {});
    assert.deepEqual(result.items[0].transform, [0, -10, 10, 0, 100, 560]);
});

test('unclassified small mathematical fragments are not silently discarded', () => {
    const nodes = extract([...paragraph(40, 730), ...paragraph(40, 540), text('∫', 120, 625, 8, 6)]);
    assert.ok(nodes.some((node) => node.str.includes('∫')));
});

test('a footnote above a diagram remains outside the crop', () => {
    const nodes = extract([...paragraph(40, 730), ...paragraph(40, 330),
        text('1', 40, 654, 4, 6), text('An explanatory footnote belongs to the surrounding prose.', 45, 650, 232, 9),
        text('Figure 1. Diagram.', 40, 390, 230, 9)], [shape(50, 430, 210, 170)]);
    assert.ok(top(figures(nodes)[0].rect) < 647);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('explanatory footnote')));
});

test('scanned figure masks preserve thin ink and use bottom-left coordinates', async () => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    pixels[(20 * 100 + 11) * 4] = 220;
    const page = {
        getViewport: () => ({width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100]}),
        getTextContent: async () => ({items: [text('Figure 1. Diagram.', 10, 20, 80, 9)]}),
        getOperatorList: async () => ({fnArray: [1, 2], argsArray: [[100, 0, 0, 100, 0, 0], []]}),
        render: () => ({promise: Promise.resolve()})
    };
    const canvas = {width: 100, height: 100, getContext: () => ({getImageData: () => ({data: pixels})})};
    const input = await extractPageInputFromPDFPage(page, 1, {transform: 1, paintImageXObject: 2}, () => canvas);
    assert.equal(input.ink.width, 50);
    assert.equal(input.ink.cells[39 * 50 + 5], 1);
    assert.equal(input.ink.cells.reduce((sum, value) => sum + value, 0), 1);
    assert.equal(canvas.width, 0, 'temporary rendering buffers are released');
});

test('scanned pages without captions do not require a rendering pass', async () => {
    const page = {
        getViewport: () => ({width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100]}),
        getTextContent: async () => ({items: [text('Ordinary prose', 10, 50, 80)]}),
        getOperatorList: async () => ({fnArray: [1, 2], argsArray: [[100, 0, 0, 100, 0, 0], []]})
    };
    const input = await extractPageInputFromPDFPage(page, 1, {transform: 1, paintImageXObject: 2}, () => assert.fail('unexpected rendering'));
    assert.equal(input.ink, undefined);
});

test('small page decorations containing math-like punctuation stay out of prose', () => {
    const nodes = extract([...paragraph(40, 730), ...paragraph(40, 540),
        text('Conference publication information | copyright and document identifier', 10, 625, 400, 6),
        text('∗', 120, 610, 5, 6)]);
    assert.ok(nodes.every((node) => !node.str.includes('publication information') && !node.str.includes('∗')));
});
