// 実PDFはリポジトリに追加せず、手元のコーパスに対して同じ検証を再実行する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const specs = require('./regions.json');
const ts = require('typescript');
const engine = {};
new Function('exports', ts.transpileModule(fs.readFileSync('src/core/extractor.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText)(engine);
const input = path.resolve(process.argv[2] || 'work');
let checked = 0;
let checkedLists = 0;
for (const name of Object.keys(specs)) {
    const file = name + '.json';
    const nodes = JSON.parse(fs.readFileSync(path.join(input, file), 'utf8'));
    const spec = specs[name];
    for (const [field, type] of [['title', 2], ['author', 7]]) {
        if (spec[field]) assert.deepEqual(nodes.filter((n) => n.type === type).map((n) => n.str), [spec[field]],
            `${file}: ${field}`);
    }
    if (spec.referenceCount) {
        const start = nodes.findIndex((n) => n.type === 3 && /^References:?$/i.test(n.str));
        assert.ok(start >= 0, `${file}: references heading`);
        const entries = nodes.slice(start + 1).filter((n) => n.type === 1 && !n.footnote && /^\[\d+\]\s/.test(n.str));
        const expected = Array.from({length: spec.referenceCount}, (_, i) => String(i + 1));
        assert.deepEqual(entries.map((n) => n.str.match(/^\[(\d+)\]/)[1]), expected, `${file}: reference entries`);
        const context = engine.buildHTMLLinkContext(nodes);
        entries.forEach((entry, i) => assert.equal(context.references.get(expected[i]), context.ids.get(entry),
            `${file}: reference ${expected[i]} must link to its bibliography entry`));
    }
    assert.equal(nodes.filter((n) => n.type === 5).length, spec.figures, `${file}: figure count`);
    assert.equal(nodes.filter((n) => n.type === 6).length, spec.equations, `${file}: equation count`);
    assert.equal(nodes.filter((n) => n.type === 9).length, spec.blocks || 0, `${file}: uncaptioned block count`);
    assert.ok(nodes.filter((n) => [5, 6, 9].includes(n.type)).every((n) => n.rect), `${file}: missing crop`);
    let shortRun = [];
    for (const node of nodes) {
        const text = node.str.trim();
        if (node.type !== 1 || text.length > 8 && text.split(/\s+/).length > 2 ||
            /[.!?]$|^(?:[•●◦▪]|\d+[.)])\s/.test(text)) { shortRun = []; continue; }
        if (shortRun[0]?.sourceRect?.page !== node.sourceRect?.page) shortRun = [];
        shortRun.push(node);
        assert.ok(shortRun.length < 3, `${file}: suspicious short paragraphs on page ${node.sourceRect?.page}: ${shortRun.map((n) => n.str).join(' / ')}`);
    }
    for (const heading of spec.headings || []) assert.ok(nodes.some((node) => node.type === 3 && node.str === heading),
        `${file}: missing heading ${heading}`);
    let previousHeading = -1;
    for (const heading of spec.headingOrder || []) {
        const index = nodes.findIndex((node) => node.type === 3 && node.str === heading);
        assert.ok(index > previousHeading, `${file}: missing or reordered heading ${heading}`);
        previousHeading = index;
    }
    for (const text of spec.prose || []) assert.ok(nodes.some((node) => node.type === 1 && node.str.includes(text)),
        `${file}: fragmented or reordered prose: ${text}`);
    for (const text of spec.paragraphStarts || []) assert.ok(nodes.some((node) => node.type === 1 && node.str.startsWith(text)),
        `${file}: paragraph merged into preceding content: ${text}`);
    for (const text of spec.absent || []) assert.ok(nodes.every((node) => !node.str.includes(text)),
        `${file}: unexpected text: ${text}`);
    for (const text of spec.absentParagraphs || []) assert.ok(nodes.every((node) => node.type !== 1 || node.str !== text),
        `${file}: detached fragment: ${text}`);
    for (const caption of spec.captions || []) assert.ok(nodes.some((node) => node.type === 5 && node.str === caption),
        `${file}: incomplete caption: ${caption}`);
    if (spec.linkedProse) {
        const context = engine.buildHTMLLinkContext(nodes);
        for (const prefix of spec.linkedProse) {
            const node = nodes.find((node) => node.type === 1 && node.str.startsWith(prefix));
            assert.ok(node && !context.ids.has(node), `${file}: prose mistaken for a reference: ${prefix}`);
            for (const match of node.str.matchAll(/\[(\d+)\]/g)) assert.ok(
                engine.linkedNodeHTML(node, context).includes(`href="#${context.references.get(match[1])}"`),
                `${file}: citation ${match[0]} not linked in ${prefix}`);
        }
    }
    for (const expected of spec.lists || []) {
        const startText = typeof expected.items[0] === 'string' ? expected.items[0] : expected.items[0].text;
        const start = nodes.findIndex(node => node.sourceRect?.page === expected.page &&
            engine.bulletListItemText(node)?.startsWith(startText));
        assert.ok(start >= 0, `${file}: missing list on page ${expected.page}: ${startText}`);
        const checkItems = (items, expectedItems) => {
            assert.equal(items.length, expectedItems.length, `${file}: list length: ${startText}`);
            items.forEach((item, i) => {
                const spec = typeof expectedItems[i] === 'string' ? {text: expectedItems[i]} : expectedItems[i];
                assert.ok(engine.bulletListItemText(nodes[item.index]).startsWith(spec.text), `${file}: list item: ${spec.text}`);
                if (spec.includes) assert.ok(nodes[item.index].str.includes(spec.includes), `${file}: split item: ${spec.text}`);
                checkItems(item.children, spec.children || []);
            });
        };
        checkItems(engine.bulletListAt(nodes, start).items, expected.items);
        checkedLists++;
    }
    if (spec.readableMath) assert.ok(nodes.filter((node) => node.type !== 6).every((node) =>
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/.test(node.str)), `${file}: unreadable math in prose or captions`);
    for (const node of nodes) {
        const markers = node.str.match(/⟦math-\d+-\d+⟧/g) || [];
        assert.deepEqual([...markers].sort(), (node.inlineImages || []).map((image) => image.marker).sort(),
            `${file}: inline formulas must stay attached to their paragraph`);
        for (const image of node.inlineImages || []) assert.ok(image.rect.width > 0 && image.rect.height > 0,
            `${file}: empty inline formula`);
    }
    for (const region of spec.regions) {
        const pageNodes = nodes.filter((node) => node.rect?.page === region.page);
        const [x, y, width, height] = region.content;
        const label = region.caption || (region.blockIndex ? `page ${region.page} uncaptioned block #${region.blockIndex}` :
            region.inline ? `page ${region.page} inline formula at ${x}, ${y}` :
            region.equationIndex ? `page ${region.page} equation #${region.equationIndex}` : region.equation);
        const candidates = region.inline ? nodes.flatMap((node) => node.inlineImages || []).filter(({rect: r}) =>
            r.page === region.page && x + width / 2 >= r.x && x + width / 2 <= r.x + r.width &&
            y + height / 2 >= r.y && y + height / 2 <= r.y + r.height)
            : region.equationIndex || region.blockIndex
            ? pageNodes.filter((node) => node.type === (region.blockIndex ? 9 : 6)).sort((a, b) => b.rect.y - a.rect.y)
                .slice((region.blockIndex || region.equationIndex) - 1, region.blockIndex || region.equationIndex)
            : pageNodes.filter((node) => region.caption
            ? node.type === 5 && node.str.startsWith(region.caption)
            : node.type === 6 && new RegExp(`\\(${region.equation}\\)`).test(node.str));
        assert.equal(candidates.length, 1, `${file}: ${label} must match once`);
        const r = candidates[0].rect;
        assert.ok(r.x <= x && r.y <= y && r.x + r.width >= x + width && r.y + r.height >= y + height,
            `${file}: ${label} clips expected content: ${JSON.stringify(r)}`);
        for (const [px, py] of region.exclude || []) assert.ok(!(px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height),
            `${file}: ${label} includes neighboring content at ${px}, ${py}`);
        checked++;
    }
    console.log(`${file}: ${spec.regions.length} regions passed`);
}
console.log(`${checked} annotated regions and ${checkedLists} lists passed`);
