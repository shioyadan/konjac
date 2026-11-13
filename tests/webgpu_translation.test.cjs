const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(readFileSync('src/core/webgpu_translation.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText;
function setup({create, translate} = {}) {
    let destroyed = 0;
    const device = {destroy() { destroyed++; }};
    const adapter = {limits: {maxStorageBufferBindingSize: 1, maxBufferSize: 1, maxStorageBuffersPerShaderStage: 1},
        async requestDevice() { return device; }};
    const exports = {};
    new Function('exports', 'require', 'navigator', code)(exports, () => ({
        HachiueEngine: {create: create ?? (async () => ({dispose() { device.destroy(); }}))},
        translateText: translate ?? (async () => ({translation: '訳文', stats: {generatedTokens: 2}}))
    }), {gpu: {async requestAdapter() { return adapter; }}});
    return {...exports, destroyed: () => destroyed};
}
test('long input is bounded without losing text or splitting surrogate pairs', () => {
    const {translationChunks} = setup();
    for (const input of ['Sentence. '.repeat(400), 'x'.repeat(599) + '😀'.repeat(1000), 'word '.repeat(400)]) {
        const chunks = translationChunks(input);
        assert.equal(chunks.join(''), input);
        assert.ok(chunks.every(chunk => chunk.length <= 600 && !/[\uD800-\uDBFF]$/.test(chunk)));
    }
});
test('initialization failure releases GPU resources', async () => {
    const api = setup({create: async () => { throw new Error('download failed'); }});
    await assert.rejects(api.createWebGPUTranslator(new AbortController().signal, () => {}), /download failed/);
    assert.equal(api.destroyed(), 1);
});
test('abort discards partial generation and does not start another chunk', async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = setup({translate: async () => {
        calls++;
        controller.abort();
        return {translation: 'partial', stats: {generatedTokens: 2}};
    }});
    const translator = await api.createWebGPUTranslator(controller.signal, () => {});
    await assert.rejects(translator.translate('Long input. '.repeat(200)), {name: 'AbortError'});
    assert.equal(calls, 1);
    translator.destroy();
    assert.equal(api.destroyed(), 1);
});
test('token budget exhaustion is reported instead of saving truncated text', async () => {
    const api = setup({translate: async () => ({translation: 'partial', stats: {generatedTokens: 1536}})});
    const translator = await api.createWebGPUTranslator(new AbortController().signal, () => {});
    await assert.rejects(translator.translate('Source'), /incomplete/);
    translator.destroy();
});
test('selected 2B weights are passed to the engine with WebGPU enforced', async () => {
    const loaded = [];
    const api = setup({create: async options => {
        loaded.push(options);
        return {dispose() {}};
    }});
    for (const id of ['2b-q4_0', '2b-q4_k_m']) {
        const translator = await api.createWebGPUTranslator(new AbortController().signal, () => {}, id);
        translator.destroy();
    }
    assert.deepEqual(loaded.map(options => options.url), [
        'https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_0.gguf',
        'https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/main/plamo-3-translate-2b-Q4_K_M.gguf'
    ]);
    assert.ok(loaded.every(options => options.backend === 'webgpu'));
});
test('an unknown model is rejected before engine initialization', async () => {
    let initialized = false;
    const api = setup({create: async () => { initialized = true; }});
    await assert.rejects(api.createWebGPUTranslator(new AbortController().signal, () => {}, 'missing'), /Unknown translation model/);
    assert.equal(initialized, false);
});
