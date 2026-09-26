// 実PDFはリポジトリに追加せず、手元のコーパスに対して同じ検証を再実行する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const specs = require('./regions.json');
const input = path.resolve(process.argv[2] || 'work');
let checked = 0;
for (const name of Object.keys(specs)) {
    const file = name + '.json';
    const nodes = JSON.parse(fs.readFileSync(path.join(input, file), 'utf8'));
    const spec = specs[name];
    assert.equal(nodes.filter((n) => n.type === 5).length, spec.figures, `${file}: figure count`);
    assert.equal(nodes.filter((n) => n.type === 6).length, spec.equations, `${file}: equation count`);
    assert.ok(nodes.filter((n) => n.type === 5 || n.type === 6).every((n) => n.rect), `${file}: missing crop`);
    for (const heading of spec.headings || []) assert.ok(nodes.some((node) => node.type === 3 && node.str === heading),
        `${file}: missing heading ${heading}`);
    for (const region of spec.regions) {
        const candidates = nodes.filter((node) => node.rect?.page === region.page && (region.caption
            ? node.type === 5 && node.str.startsWith(region.caption)
            : node.type === 6 && new RegExp(`\\(${region.equation}\\)`).test(node.str)));
        assert.equal(candidates.length, 1, `${file}: ${region.caption || region.equation} must match once`);
        const r = candidates[0].rect, [x, y, width, height] = region.content;
        assert.ok(r.x <= x && r.y <= y && r.x + r.width >= x + width && r.y + r.height >= y + height,
            `${file}: ${region.caption || region.equation} clips expected content: ${JSON.stringify(r)}`);
        for (const [px, py] of region.exclude || []) assert.ok(!(px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height),
            `${file}: ${region.caption || region.equation} includes neighboring content at ${px}, ${py}`);
        checked++;
    }
    console.log(`${file}: ${spec.regions.length} regions passed`);
}
console.log(`${checked} annotated regions passed`);
