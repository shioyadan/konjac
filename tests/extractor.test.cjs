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

test('small outlined glyphs at the edge of a diagram remain in the crop', () => {
    const glyph = shape(278, 580, 1.9, 2.8);
    const nodes = extract([...paragraph(40, 710), ...paragraph(40, 330),
        text('Figure 1. Diagram with outlined text.', 40, 390, 230, 9)], [shape(55, 430, 210, 180), glyph]);
    assert.ok(encloses(figures(nodes)[0].rect, glyph));
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

test('a column of figures is not stopped by prose in the other column', () => {
    const panels = [shape(70, 570, 210, 130), shape(70, 370, 210, 130)];
    const nodes = extract([...paragraph(320, 700), ...paragraph(320, 600), ...paragraph(320, 470),
        text('Figure 1. Upper panel.', 65, 535, 215, 9), text('Figure 2. Lower panel.', 65, 335, 215, 9)], panels);
    const result = figures(nodes);
    assert.equal(result.length, 2);
    for (let i = 0; i < panels.length; i++) {
        assert.ok(encloses(result[i].rect, panels[i]));
        assert.ok(right(result[i].rect) < 320);
    }
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

test('a caption below a ruled table does not claim the following chart', () => {
    const table = shape(55, 600, 210, 100), chart = shape(55, 430, 210, 120);
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 330),
        text('Table 1. Measurements.', 40, 580, 230, 9), text('Figure 1. Diagram.', 40, 390, 230, 9)],
        [table, shape(55, 600, 210, 1), chart]);
    const [a, b] = figures(nodes);
    assert.ok(encloses(a.rect, table));
    assert.ok(encloses(b.rect, chart));
    assert.ok(a.rect.y > top(b.rect));
});

test('a short final word remains with prose above a figure', () => {
    const nodes = extract([...paragraph(40, 710), text('results.', 40, 668, 30), ...paragraph(40, 330),
        text('Figure 1. Diagram.', 40, 390, 230, 9)], [shape(55, 430, 210, 210)]);
    assert.ok(top(figures(nodes)[0].rect) < 665);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('results.')));
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

test('single-column reading order keeps right-hand fragments before following prose', () => {
    const nodes = extract([...paragraph(40, 750).map((item) => ({...item, width: 400})),
        text('left fragment', 100, 660, 90), text('right fragment', 350, 660, 80),
        text('Following prose describes the result in a single column.', 40, 620, 400)]);
    const output = nodes.map((node) => node.str).join(' ');
    assert.ok(output.indexOf('right fragment') < output.indexOf('Following prose'));
});

test('sparse columns of figures keep caption continuation in its column', () => {
    const nodes = extract([text('Figure 1. The left diagram and its', 40, 400, 210, 9),
        text('continued description.', 40, 389, 150, 9),
        text('Figure 2. The right diagram.', 320, 399, 200, 9)],
        [shape(50, 450, 210, 150), shape(330, 450, 210, 150)]);
    assert.ok(figures(nodes).find((node) => node.str.startsWith('Figure 1.')).str.endsWith('continued description.'));
});

test('short prose in the body font separates adjacent unnumbered fractions', () => {
    const font = (item, fontName) => ({...item, fontName});
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 580)].map((item) => font(item, 'body')).concat([
        font(text('a', 155, 685, 10), 'math'), font(text('u =', 100, 678, 30), 'math'),
        font(text('b', 155, 671, 10), 'math'),
        font(text('As', 40, 650, 10), 'body'), font(text('p = q', 55, 650, 40), 'math'),
        font(text(', we obtain', 115, 650, 55), 'body'),
        font(text('c', 155, 631, 10), 'math'), font(text('v =', 100, 624, 30), 'math'),
        font(text('d', 155, 617, 10), 'math')
    ]));
    const eq = equations(nodes);
    assert.equal(eq.length, 2);
    assert.ok(eq[0].str.includes('u =') && eq[1].str.includes('v ='));
    assert.ok(eq[0].rect.y > 660 && top(eq[1].rect) < 648);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('we obtain')));
});

test('unnumbered integrals can touch estimated body bounds without absorbing prose', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 660),
        text('∫', 115, 713, 8), text('1', 128, 710, 5, 7),
        text('m =', 85, 699, 25), text('f(x) dx =', 138, 699, 55),
        text('a', 205, 706, 8), text('b', 205, 691, 8), text('0', 124, 688, 5, 7)]);
    const [eq] = equations(nodes);
    assert.equal(equations(nodes).length, 1);
    assert.ok(eq.str.includes('∫') && eq.str.includes('0') && eq.str.includes('b'));
    assert.ok(top(eq.rect) <= 720 && eq.rect.y > 670);
});

test('zero in a case expression and fraction rules remain inside the equation', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('f = x / y', 100, 660, 110), text('0', 180, 645, 8), text('(1)', 265, 655, 15)],
        [shape(175, 650, 40, 1)]);
    const [eq] = equations(nodes);
    assert.ok(eq.str.includes('0'));
    assert.ok(right(eq.rect) >= 215 && eq.rect.y <= 645);
});

test('numbered expressions need no relation symbol and accept either number margin', () => {
    for (const [x, number] of [[265, '(1)'], [40, '(2.1a)']]) {
        const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
            text('a + b', 100, 660, 100), text(number, x, 660, 15)]);
        const [eq] = equations(nodes);
        assert.equal(equations(nodes).length, 1);
        assert.ok(eq.str.includes(number) && eq.str.includes('a + b'));
        assert.ok(encloses(eq.rect, {x: 100, y: 660, width: 100, height: 10}));
    }
});

test('numbered fractions and matrices include rows on both sides of the number', () => {
    const cases = [
        [text('a', 140, 671, 10, 8), text('b', 140, 650, 10, 8)],
        [text('[ a b ]', 100, 671, 100), text('[ c d ]', 100, 650, 100)]
    ];
    for (const items of cases) {
        const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540), ...items,
            text('(1)', 265, 660, 15)], [shape(135, 665, 25, 0.5)]);
        const [eq] = equations(nodes);
        assert.ok(eq && eq.str.includes('a') && eq.str.includes('b'));
        assert.ok(eq.rect.y <= 648 && top(eq.rect) >= 679);
    }
});

test('a bare number, short numbered label, and numbered prose are not equations', () => {
    for (const str of ['', 'Fast path', 'A conventional numbered item explains the experimental setup.']) {
        const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540), text('(1)', 40, 660, 15),
            ...(str ? [text(str, 80, 660, str.length > 20 ? 200 : 80)] : [])]);
        assert.equal(equations(nodes).length, 0, str);
    }
});

const tableRow = (y, i, size = 8) => [text(i ? 'M' + i : 'Method', 50, y, 40, size),
    text(i ? String(i * 12) : 'Latency', 145, y, 40, size), text(i ? String(i * 25) : 'Rate', 240, y, 25, size)];

test('borderless tables keep widely spaced rows and stop before prose', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540), text('Table 1. Measurements.', 40, 690, 230, 9),
        ...tableRow(650, 0), ...tableRow(626, 1), ...tableRow(602, 2)]);
    const [table] = figures(nodes);
    assert.ok(encloses(table.rect, {x: 50, y: 602, width: 215, height: 56}));
    assert.ok(table.rect.y > 555);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('Ordinary prose')));
});

test('right-aligned numeric cells bridge table rows without absorbing a distant note', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 490), text('Table 1. Measurements.', 40, 690, 230, 9),
        ...tableRow(650, 0), text('M1', 50, 626, 15, 8), text('12', 175, 626, 10, 8), text('1250', 245, 626, 20, 8),
        text('M2', 50, 602, 15, 8), text('1250', 165, 602, 20, 8), text('3', 260, 602, 5, 8),
        text('A separate explanatory note.', 50, 560, 150, 8)]);
    const [table] = figures(nodes);
    assert.ok(encloses(table.rect, {x: 50, y: 602, width: 215, height: 56}));
    assert.ok(table.rect.y > 575);
});

test('cell alignment selects a borderless table above its caption', () => {
    const chart = shape(55, 430, 210, 100);
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 330),
        ...tableRow(680, 0), ...tableRow(656, 1), ...tableRow(632, 2),
        text('Table 1. Measurements.', 40, 605, 230, 9), text('Figure 1. Diagram.', 40, 390, 230, 9)], [chart]);
    const [table, figure] = figures(nodes);
    assert.ok(encloses(table.rect, {x: 50, y: 632, width: 215, height: 56}));
    assert.ok(encloses(figure.rect, chart));
    assert.ok(table.rect.y > top(figure.rect));
});

test('a table caption does not absorb its first row of cells', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540), text('Table 1. Measurements.', 40, 690, 230, 9),
        ...tableRow(678, 0, 9), ...tableRow(654, 1, 9), ...tableRow(630, 2, 9)]);
    const [table] = figures(nodes);
    assert.equal(table.str, 'Table 1. Measurements.');
    assert.ok(encloses(table.rect, {x: 50, y: 630, width: 215, height: 57}));
});

test('caption wrapping uses layout and stops before a new paragraph', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 340), text('Table 1. Measurements of the', 40, 680, 230, 9),
        text('experimental setup and its results.', 40, 668, 230, 9), ...tableRow(640, 0), ...tableRow(616, 1),
        text('Figure 1. Two panels are shown.', 40, 390, 230, 9), text('The upper panel is the baseline.', 40, 378, 230, 9)],
        [shape(55, 430, 210, 100)]);
    const [table, figure] = figures(nodes);
    assert.equal(table.str, 'Table 1. Measurements of the experimental setup and its results.');
    assert.equal(figure.str, 'Figure 1. Two panels are shown. The upper panel is the baseline.');
});

test('repeated running headers and footers stay out of figures and prose', () => {
    const pages = [{width: 600, height: 800, items: paragraph(40, 700)}];
    for (let page = 2; page <= 4; page++) pages.push({width: 600, height: 800,
        items: [text('A running journal title', 40, 755, 180), text(`30:${page}`, 260, 755, 20),
            text('Repeated journal footer', 40, 40, 240, 8), ...paragraph(40, 400),
            text(`Figure ${page}. A plot.`, 40, 470, 230, 9)],
        graphics: [{...shape(55, 500, 210, 230), page}]});
    const nodes = extractNodesFromPages(pages);
    assert.equal(figures(nodes).length, 3);
    assert.ok(figures(nodes).every((n) => top(n.rect) < 745 && encloses(n.rect, {x: 55, y: 500, width: 210, height: 230})));
    assert.ok(nodes.every((n) => !/running journal|journal footer|30:/.test(n.str)));
});

test('single prose lines containing inline math bound a numbered equation', () => {
    const before = 'The equation x = y explains the result that we derive below.';
    const after = 'The result a = b is used to calculate the following measurements.';
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540), text(before, 40, 685, 240),
        text('x = a + b', 100, 660, 120), text('(1)', 265, 660, 15), text(after, 40, 640, 240)]);
    const [eq] = equations(nodes);
    assert.equal(equations(nodes).length, 1);
    assert.ok(!eq.str.includes('result'));
    assert.ok(top(eq.rect) < 683 && eq.rect.y > 650);
    assert.ok(nodes.some((n) => n.type === 1 && n.str.includes(before)));
    assert.ok(nodes.some((n) => n.type === 1 && n.str.includes(after)));
});

test('unmapped math glyphs do not pull a short prose ending into the crop', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('The mathematical expression for the following prediction result', 40, 680, 240), text('is:', 40, 666, 10),
        text('\u0002E, *\u00042, *\u0001', 120, 656, 100, 20.5), text('(1)', 265, 656, 15),
        text('The resulting probability is used in the following measurements.', 40, 636, 240)]);
    const [eq] = equations(nodes);
    assert.equal(equations(nodes).length, 1);
    assert.ok(!eq.str.includes('is:'));
    assert.ok(top(eq.rect) <= 663.5 && eq.rect.y >= 646);
});

test('a long multi-cell table row is not a standalone prose boundary', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        ...tableRow(685, 0, 10), ...tableRow(665, 1, 10),
        text('memory fence', 50, 645, 55), text('scalar-vector, vector-scalar, vector-vector', 130, 645, 150),
        text('Table 1. Instructions.', 40, 620, 230, 9)]);
    const [table] = figures(nodes);
    assert.ok(table.rect && encloses(table.rect, {x: 50, y: 645, width: 230, height: 50}));
});

test('stacked table sections stay together across a spanning header', () => {
    const nodes = extract([...paragraph(40, 770), ...paragraph(40, 470),
        ...tableRow(710, 0), ...tableRow(690, 1), ...tableRow(670, 2),
        text('Second group', 130, 640, 80, 8), ...tableRow(626, 0), ...tableRow(606, 1), ...tableRow(586, 2),
        text('Table 1. Measurements.', 40, 560, 230, 9)]);
    const [table] = figures(nodes);
    assert.ok(encloses(table.rect, {x: 50, y: 586, width: 215, height: 132}));
    assert.ok(table.rect.y > 570 && top(table.rect) < 740);
});

test('CropBox translation is applied to both text and drawings', async () => {
    const page = {
        getViewport: () => ({width: 594, height: 774, transform: [1, 0, 0, -1, -36, 810]}),
        getTextContent: async () => ({items: [{...text('sample', 70, 100, 30), fontName: 'mono'}],
            styles: {mono: {fontFamily: 'monospace', ascent: .727}}}),
        getOperatorList: async () => ({fnArray: [1, 2], argsArray: [[[0], [70, 100, 90, 120], [70, 100, 90, 120]], []]})
    };
    const result = await extractPageInputFromPDFPage(page, 1, {constructPath: 1, fill: 2});
    assert.equal(result.items[0].transform[4], 34);
    assert.equal(result.items[0].transform[5], 64);
    assert.equal(result.items[0].monospace, true);
    assert.equal(result.items[0].fontAscent, .727);
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

test('solid image masks contribute table rules while white masks are ignored', async () => {
    const page = {
        getViewport: () => ({width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]}),
        getTextContent: async () => ({items: []}),
        getOperatorList: async () => ({fnArray: [1, 2, 3, 2, 4], argsArray: [
            [200, 0, 0, -0.5, 40, 600], [], new Uint8ClampedArray([255, 255, 255]), [], []
        ]})
    };
    const input = await extractPageInputFromPDFPage(page, 1, {
        transform: 1, paintSolidColorImageMask: 2, setFillRGBColor: 3, paintImageXObject: 4
    });
    assert.equal(input.graphics.length, 2);
    assert.deepEqual(input.graphics[0], {page: 1, kind: 'path', x: 40, y: 599.5, width: 200, height: 0.5, strokeWidth: 0});
    assert.equal(input.graphics[1].kind, 'image', 'ordinary images do not inherit the fill color');
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

test('unmapped Type3 glyphs use their painted boxes and TJ spacing', async () => {
    const ops = {beginText: 1, setTextMatrix: 2, setFont: 3, showText: 4, setCharWidthAndBounds: 5};
    const font = {isType3Font: true, fontMatrix: [1, 0, 0, 1, 0, 0], bbox: [0, -5, 10, 60],
        charProcOperatorList: {a: {fnArray: [5], argsArray: [[0, 0, 0, 0, 6, 8]]}, space: {fnArray: [], argsArray: []}}};
    const page = {
        getViewport: () => ({width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]}),
        getTextContent: async () => ({items: [{...text('\u0001\u0001', 40, 700, 0, 65), fontName: 'math'}]}),
        commonObjs: {get: () => font},
        getOperatorList: async () => ({fnArray: [1, 2, 3, 4], argsArray: [[], [1, 0, 0, 1, 40, 700], ['math', 1],
            [[{operatorListId: 'a', width: 0}, {operatorListId: 'space', width: 0}, -12000, {operatorListId: 'a', width: 0}]]]})
    };
    const input = await extractPageInputFromPDFPage(page, 1, ops);
    assert.equal(input.items.length, 2);
    assert.deepEqual(input.items.map((item) => [item.inkRect.x, item.inkRect.y, item.inkRect.width, item.inkRect.height]),
        [[40, 700, 6, 8], [52, 700, 6, 8]]);
    assert.ok(input.items.every((item) => item.unmapped));
    font.charProcOperatorList.space = {fnArray: [999], argsArray: [[]]};
    const incomplete = await extractPageInputFromPDFPage(page, 1, ops);
    assert.equal(incomplete.items[0].str, '\u0001\u0001', 'unsupported drawings preserve the original text instead of dropping glyphs');
});

const painted = (x, y, width, height) => ({...text('�', x, y, width, height), unmapped: true,
    inkRect: {page: 2, x, y, width, height}});

test('inline fractions remain between prose and retain superscripts in the image', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('With probability', 40, 650, 70), painted(115, 650, 8, 7),
        painted(125, 654, 6, 5), painted(125, 643, 6, 5),
        text('the condition holds.', 140, 650, 140)]);
    const node = nodes.find((node) => node.str.includes('With probability'));
    assert.equal(equations(nodes).length, 0);
    assert.equal(node.inlineImages?.length, 1);
    const image = node.inlineImages[0];
    assert.ok(node.str.indexOf('With probability') < node.str.indexOf(image.marker));
    assert.ok(node.str.indexOf(image.marker) < node.str.indexOf('the condition holds'));
    assert.ok(encloses(image.rect, {page: 2, x: 115, y: 643, width: 16, height: 16}));
    assert.ok(right(image.rect) < 140);
});

test('a wrapped formula followed by a period stays before the following sentence', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('The first probability is smaller than', 40, 660, 240),
        painted(40, 646, 8, 7), painted(49, 645, 4, 4), text('.', 56, 646, 3),
        text('Two situations can occur in this example.', 40, 632, 240)]);
    const output = nodes.map((node) => node.str).join(' ');
    const image = nodes.flatMap((node) => node.inlineImages ?? [])[0];
    assert.ok(image);
    assert.ok(output.indexOf(image.marker) < output.indexOf('Two situations'));
    assert.ok(!output.includes('�'));
});

test('inline crop padding never clips a known superscript near the preceding row', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('A short preceding line.', 40, 660, 90),
        text('With probability', 40, 650, 70), painted(115, 650, 8, 7), painted(124, 655, 4, 4),
        text('the condition holds.', 140, 650, 140)]);
    const node = nodes.find((node) => node.str.includes('With probability'));
    assert.ok(encloses(node.inlineImages[0].rect, {x: 115, y: 650, width: 13, height: 9}));
});

test('inline formulas survive translation and HTML escapes adjacent translated prose', () => {
    const code = ts.transpileModule(readFileSync('src/core/translation.ts', 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
    }).outputText;
    const translation = {};
    new Function('exports', 'require', code)(translation, () => engine.exports);
    const marker = '⟦math-2-1⟧';
    const node = new engine.exports.PDF_Node(`The probability is ${marker}.`, 1);
    node.inlineImages = [{marker, rect: {page: 2, x: 50, y: 650, width: 20, height: 12},
        fontSize: 10, baseline: 653, imageSrc: 'data:image/png;base64,AA=='}];
    const doc = translation.createTranslationDocument('sample.pdf', 'sample', [node]);
    assert.ok(doc.instructions.includes('marker'));
    const translated = translation.translatedNodesFromEntries([{nodeIndex: 0, block: {...doc.blocks[0], translation: `<value> ${marker}`}}], [node]);
    const html = engine.exports.nodesToHTML(translated, [node]);
    assert.match(html, /&lt;value&gt;/);
    assert.match(html, /class="inline-math"/);
    assert.match(html, /vertical-align: -0.3em/);
    assert.ok(!html.includes(`<value>`));
    assert.equal(node.str, `The probability is ${marker}.`);
});

test('an uncaptioned numeric grid stays in one block with its row labels and rule', () => {
    const cells = [680, 666, 652, 638].flatMap((y, row) => [100, 140, 180, 220].map((x, col) =>
        text(col ? String(row + col) : ['x', 'a', 'b', 'c'][row], x, y, 6)));
    const nodes = extract([...paragraph(40, 750), ...cells, ...paragraph(40, 590)], [shape(98, 675, 132, .5)]);
    const blocks = nodes.filter((node) => node.type === 9);
    assert.equal(blocks.length, 1);
    assert.ok(encloses(blocks[0].rect, {x: 98, y: 638, width: 132, height: 52}));
    assert.equal(equations(nodes).length, 0);
    assert.ok(nodes.filter((node) => node.type === 1).every((node) => node.str.length > 8));
});

test('indented code keeps assignments, braces, subscripts, and comments in one image', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 590),
        text('j = count', 80, 680, 50), text('for (i = count; i >= 0; i--) {', 80, 666, 160),
        text('if (a < b) j = i;', 90, 652, 90), text('}', 80, 638, 6),
        text('// return the selected entry', 80, 624, 150)]);
    const [block] = nodes.filter((node) => node.type === 9);
    assert.ok(block && encloses(block.rect, {x: 80, y: 624, width: 160, height: 66}));
    assert.ok(!nodes.filter((node) => node.type === 1).some((node) => node.str.includes('return the selected')));
    block.imageSrc = 'data:image/png;base64,AA==';
    assert.match(engine.exports.nodesToHTML(nodes), /<figure class="block-image"><img/);
});

test('short prose and bullet lists do not become uncaptioned grids', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('Yes.', 100, 680, 20), text('No.', 100, 666, 20), text('Maybe.', 100, 652, 35),
        text('• Red', 100, 620, 40), text('• Green', 100, 606, 40), text('• Blue', 100, 592, 40)]);
    assert.ok(nodes.every((node) => node.type !== 9));
});

test('OCR fragments on one prose baseline are joined in horizontal order', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(320, 750), ...paragraph(40, 540), ...paragraph(320, 540),
        text('The left column has its own baseline.', 40, 652, 240),
        text('The complete', 320, 650.1, 60), text('sentence has', 385, 649.7, 60),
        text('the correct', 450, 650.1, 50), text('word order.', 505, 649.7, 50)]);
    assert.ok(nodes.some((node) => node.str.includes('The complete sentence has the correct word order.')));
    assert.ok(nodes.every((node) => node.type !== 9));
});

test('wide justified spaces and description labels stay within their own column', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(320, 750), ...paragraph(40, 540), ...paragraph(320, 540),
        text('The left column stays separate.', 40, 650, 240),
        text('First,', 330, 650, 20), text('the', 375, 650, 12), text('environment', 412, 650, 48),
        text('variable', 485, 650, 31), text('of', 541, 650, 8),
        text('the program determines its behavior.', 320, 636, 230),
        text('Low', 55, 610, 20), text('runs at a lower clock frequency.', 110, 610, 165),
        text('High', 55, 596, 25), text('runs at a higher clock frequency.', 110, 596, 165)]);
    assert.ok(nodes.some((node) => node.str.includes('First, the environment variable of the program')));
    assert.ok(nodes.some((node) => node.str.includes('Low runs at a lower clock frequency.')));
    assert.ok(nodes.some((node) => node.str.includes('High runs at a higher clock frequency.')));
    assert.ok(!nodes.some((node) => node.str.includes('stays separate.') && node.str.includes('First,')));
});

test('unindented monospaced commands retain wrapped lines and stop at proportional prose', () => {
    const prose = (str, y) => ({...text(str, 40, y), fontName: 'serif'});
    const command = (str, y, x = 40) => ({...text(str, x, y, str.length * 5), fontName: 'mono', monospace: true});
    const nodes = extract([
        ...paragraph(40, 750).map((line) => ({...line, fontName: 'serif'})),
        prose('The following options are used for this experiment.', 700),
        command('CFLAGS = -O3 -fopenmp', 686), command('-mcpu=example -fsave-optimization-record', 672), command('-Wall', 658),
        prose('The environment settings are specified separately.', 644),
        command('export MEMORY_POLICY', 630), command('=demand:demand', 616), command('export LOCK_TYPE=0', 602),
        prose('Ordinary prose continues with the evaluation results.', 588),
        // A monospaced identifier inside prose is not a separate code block.
        {...text('The variable', 40, 570, 60), fontName: 'serif'}, command('LOCK_TYPE', 570, 105),
        {...text('is set by the caller.', 155, 570, 120), fontName: 'serif'}
    ]);
    const blocks = nodes.filter((node) => node.type === 9);
    assert.equal(blocks.length, 2);
    assert.ok(encloses(blocks[0].rect, {x: 40, y: 658, width: 190, height: 38}));
    assert.ok(encloses(blocks[1].rect, {x: 40, y: 602, width: 100, height: 38}));
    assert.ok(blocks[0].rect.y >= 654 && top(blocks[0].rect) < 700, JSON.stringify(blocks[0].rect));
    assert.ok(blocks[1].rect.y >= 598 && top(blocks[1].rect) < 644, JSON.stringify(blocks[1].rect));
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('The variable LOCK_TYPE is set by the caller.')));
    assert.ok(nodes.filter((node) => node.type === 1).every((node) => !node.str.includes('export ')));
});

test('tight code leading preserves descenders above the following prose', () => {
    const body = (str, y) => ({...text(str, 40, y), fontName: 'serif', fontAscent: .7});
    const nodes = extract([...paragraph(40, 750).map((line) => ({...line, fontName: 'serif'})),
        body('The compiler settings are specified as follows.', 700),
        {...text('OPTIONS = -g', 40, 689, 72), fontName: 'mono', monospace: true},
        {...text('-fdebug', 40, 678, 42), fontName: 'mono', monospace: true},
        body('The following paragraph explains these options.', 667)]);
    const [block] = nodes.filter((node) => node.type === 9);
    assert.ok(block && block.rect.y <= 676 && block.rect.y >= 674);
    assert.ok(top(block.rect) < 700);
});

test('narrow column gutters do not interleave prose or reverse section headings', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(292, 750),
        text('The left column begins with its own explanation.', 40, 650),
        text('The right column contains a separate explanation.', 292, 650),
        text('Left column continuation stays with the left side.', 40, 636),
        text('Right column continuation stays with the right side.', 292, 636),
        text('3.1 First section', 40, 610, 140, 12), text('3.2 Second section', 292, 620, 140, 12),
        ...paragraph(40, 580), ...paragraph(292, 580)]);
    assert.ok(nodes.some((n) => n.str.includes('explanation. Left column continuation')));
    assert.ok(!nodes.some((n) => n.str.includes('left column begins') && n.str.includes('right column contains')));
    assert.ok(nodes.findIndex((n) => n.str === '3.1 First section') < nodes.findIndex((n) => n.str === '3.2 Second section'));
});

test('a short left-aligned caption retains an image spanning both columns', () => {
    const panel = {...shape(100, 430, 380, 250), kind: 'image'};
    const nodes = extract([...paragraph(40, 350), ...paragraph(320, 350), text('Fig. 1. Architecture.', 40, 400, 120, 9)], [panel]);
    assert.equal(figures(nodes).length, 1);
    assert.ok(encloses(figures(nodes)[0].rect, panel));
    assert.ok(figures(nodes)[0].rect.y > 410);
});

test('a table reference without a corresponding region remains prose', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 540),
        text('The comparison is shown in', 40, 650, 140),
        text('Table 1. Its values describe the measurements.', 40, 636, 240),
        text('Further discussion follows in the next section.', 40, 622, 240)]);
    assert.equal(figures(nodes).length, 0);
    assert.ok(nodes.some((n) => n.type === 1 && n.str.includes('Table 1. Its values')));
});

test('prose in the neighboring column cannot block an indented numbered equation', () => {
    const nodes = extract([...paragraph(60, 750), ...paragraph(60, 540), ...paragraph(310, 660),
        text('a = b + c', 90, 650, 160), text('(1)', 280, 650, 16)]);
    assert.equal(equations(nodes).length, 1);
    assert.ok(encloses(equations(nodes)[0].rect, {x: 90, y: 650, width: 206, height: 8}));
});

test('unindented piecewise equations keep the case labels and both branches', () => {
    const body = (items) => items.map((item) => ({...item, fontName: 'body'}));
    const nodes = extract([...body(paragraph(40, 750)), ...body(paragraph(40, 580)),
        ...body([text('effsign', 40, 650, 30)]), text('=', 90, 650, 6), text('{', 106, 661, 6),
        text('1', 120, 656, 6), text('if signprod', 220, 656, 60),
        text('msb_sum OR msb_carry otherwise', 120, 642, 160)]);
    assert.equal(equations(nodes).length, 1);
    assert.ok(encloses(equations(nodes)[0].rect, {x: 40, y: 642, width: 240, height: 25}));
    assert.ok(nodes.filter((n) => n.type === 1).every((n) => !n.str.includes('effsign')));
});

test('unmapped ordinary fonts retain bounds and stay marked on later pages', async () => {
    const symbols = {isType3Font: false, ascent: .75, descent: -.25}, prose = {};
    const page = (items) => ({getViewport: () => ({width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]}),
        getTextContent: async () => ({items}), getOperatorList: async () => ({fnArray: [], argsArray: []}),
        commonObjs: {get: (name) => name === 'symbols' ? symbols : prose}});
    await extractPageInputFromPDFPage(page([{...text('\u008a', 40, 600, 6), fontName: 'symbols'}]), 1, {});
    const result = await extractPageInputFromPDFPage(page([
        {...text('¼', 40, 600, 6), fontName: 'symbols'}, {...text('að', 60, 600, 10), fontName: 'body'},
        {...text('¼', 80, 600, 6), transform: [0, 10, -10, 0, 80, 600], fontName: 'symbols'}]), 2, {});
    assert.equal(result.items[0].unmapped, true);
    assert.deepEqual(result.items[0].inkRect, {page: 2, kind: 'path', x: 40, y: 597.5, width: 6, height: 10, strokeWidth: 0});
    assert.equal(result.items[1].unmapped, undefined);
    assert.equal(result.items[1].str, 'að');
    assert.deepEqual(result.items[2].inkRect, {page: 2, kind: 'path', x: 72.5, y: 600, width: 10, height: 6, strokeWidth: 0});
});

test('unmapped brackets identify a numbered multiline equation without guessing its symbols', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 550),
        {...text('path = square + recode + products', 60, 670, 200), unmapped: true},
        {...text('+ accumulation + registers', 90, 656, 160), unmapped: true},
        {...text('ð', 264, 642, 5), unmapped: true}, text('12', 269, 642, 10), {...text('Þ', 279, 642, 5), unmapped: true}]);
    assert.equal(equations(nodes).length, 1);
    assert.match(equations(nodes)[0].str, /\(12\)/);
    assert.ok(encloses(equations(nodes)[0].rect, {x: 60, y: 642, width: 224, height: 36}));
});

test('small footnotes keep their prose and superscripts in the same paragraph', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 550), ...paragraph(320, 750),
        text('The right column continues the main discussion.', 320, 650),
        text('1. This footnote defines', 40, 100, 88, 7), text('x', 128, 100, 4, 7),
        text('1/2', 132, 103, 7, 5), text('as the square root.', 139, 100, 65, 7),
        text('Further details follow in this explanatory note.', 40, 91, 170, 7)]);
    const note = nodes.find((n) => n.type === 1 && n.str.includes('This footnote defines'));
    assert.ok(note && note.str.includes('as the square root.') && note.inlineImages?.length === 1);
    assert.ok(!note.str.includes('right column'));
    assert.ok(note.inlineImages[0].rect.x >= 128 && right(note.inlineImages[0].rect) <= 139);
    assert.ok(!nodes.some((n) => n.str === '1/2'));
});

test('Listing captions above and below Python code preserve indentation as a figure', () => {
    for (const captionY of [680, 620]) {
        const mono = (str, x, y) => ({...text(str, x, y, str.length * 5), fontName: 'mono', monospace: true});
        const nodes = extract([...paragraph(40, 750), ...paragraph(40, 580),
            text('Listing 1: An example function.', 40, captionY, 180, 9),
            mono('def add(a, b):', 40, 660), mono('return a + b', 60, 646)]);
        const [listing] = figures(nodes);
        assert.equal(figures(nodes).length, 1);
        assert.equal(listing.str, 'Listing 1: An example function.');
        assert.ok(encloses(listing.rect, {x: 40, y: 644, width: 75, height: 24}));
        assert.ok(listing.rect.y > 590 && top(listing.rect) < 680);
        assert.ok(nodes.every((node) => ![6, 9].includes(node.type)));
        assert.ok(nodes.filter((node) => node.type === 1).every((node) => !/def add|return a/.test(node.str)));
        listing.imageSrc = 'data:image/png;base64,AA==';
        assert.match(engine.exports.nodesToHTML(nodes), /<figure><img[^>]+><figcaption>Listing 1: An example function\.<\/figcaption><\/figure>/);
    }
});

test('numbered Listings keep separate line numbers, mixed code fonts, comments and blank lines', () => {
    const code = (str, x, y, font = 'mono') => ({...text(str, x, y, str.length * 5, 9), fontName: font, monospace: true});
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 550),
        text('Listing 2.1: Accumulation.', 40, 700, 190, 9),
        {...text('1', 40, 680, 5, 8), fontName: 'serif'}, code('for', 70, 680, 'mono-bold'), code('(i = 0; i < n; ++i) {', 90, 680),
        {...text('2', 40, 668, 5, 8), fontName: 'serif'}, code('sum += values[i];', 80, 668),
        {...text('3', 40, 656, 5, 8), fontName: 'serif'}, code('}', 70, 656),
        code('// A comment after a blank line.', 70, 632),
        {...text('Ordinary prose resumes immediately after the listing.', 40, 620, 240, 10), fontName: 'serif'}]);
    const [listing] = figures(nodes);
    assert.equal(figures(nodes).length, 1);
    assert.ok(encloses(listing.rect, {x: 40, y: 630, width: 190, height: 58}));
    assert.ok(listing.rect.y >= 630 && top(listing.rect) < 698);
    assert.equal(equations(nodes).length, 0);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('Ordinary prose resumes')));
});

test('wrapped Listing captions stay outside the code crop and adjacent Listings stay separate', () => {
    const mono = (str, y) => ({...text(str, 40, y, str.length * 5, 9), fontName: 'mono', monospace: true});
    const caption = (str, y) => ({...text(str, 40, y, 200, 9), fontName: 'serif'});
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 500),
        caption('Listing 1: A sample with a caption that', 700), caption('continues onto the next line.', 688),
        mono('def first():', 670), mono('    return 1', 658),
        caption('Listing 2: Another sample.', 630), mono('def second():', 612), mono('    return 2', 600)]);
    assert.equal(figures(nodes).length, 2);
    assert.equal(figures(nodes)[0].str, 'Listing 1: A sample with a caption that continues onto the next line.');
    assert.ok(top(figures(nodes)[0].rect) < 686 && figures(nodes)[0].rect.y > 642);
    assert.ok(top(figures(nodes)[1].rect) < 630 && figures(nodes)[1].rect.y < 600);
});

test('a Listing reference without adjacent code remains prose', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(40, 550),
        text('The implementation is described in', 40, 650, 200),
        text('Listing 1. Its behavior is discussed below.', 40, 636, 240),
        text('The next section compares the experimental results.', 40, 622, 240)]);
    assert.equal(figures(nodes).length, 0);
    assert.ok(nodes.some((node) => node.type === 1 && node.str.includes('Listing 1. Its behavior')));
});

test('Listings keep neighboring-column prose outside the image', () => {
    const nodes = extract([...paragraph(40, 750), ...paragraph(320, 750), ...paragraph(40, 550),
        text('Listing 1: A short example.', 40, 680, 180, 9), ...paragraph(320, 660),
        {...text('def example():', 40, 660, 100, 9), fontName: 'mono', monospace: true},
        {...text('return 1', 60, 648, 50, 9), fontName: 'mono', monospace: true}]);
    const [listing] = figures(nodes);
    assert.ok(listing && encloses(listing.rect, {x: 40, y: 647, width: 100, height: 20}));
    assert.ok(right(listing.rect) < 320);
});

test('a Listing preserves code descenders just above proportional prose', () => {
    const body = (str, y) => ({...text(str, 40, y), fontName: 'serif', fontAscent: .7});
    const nodes = extract([...paragraph(40, 750).map((line) => ({...line, fontName: 'serif'})),
        {...text('Listing 1: Compiler options.', 40, 700, 150, 9), fontName: 'serif'},
        {...text('OPTIONS = -g', 40, 689, 72), fontName: 'mono', monospace: true},
        {...text('-fdebug', 40, 678, 42), fontName: 'mono', monospace: true},
        body('The following paragraph explains these options.', 667)]);
    const [listing] = figures(nodes);
    assert.ok(listing && listing.rect.y <= 676 && listing.rect.y >= 674);
    assert.ok(top(listing.rect) < 700);
});
