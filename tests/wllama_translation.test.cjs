const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const ts = require('typescript');
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText;
async function setup({load, complete, jspi = true} = {}) {
    const hachiue = await import('hachiue');
    const shared = {};
    new Function('exports','require',compile('src/core/webgpu_translation.ts'))(shared, () => hachiue);
    const calls = {exits:0, prompts:[]};
    class Wllama {
        constructor(paths) { calls.paths = paths; }
        getLoadedContextInfo() { return {n_vocab:100,metadata:{"general.architecture":"plamo3"}}; }
        setCompat(value) { calls.compat = value; }
        async loadModelFromUrl(url, options) { calls.url = url; calls.loadOptions = options; await load?.(); }
        async createCompletion(options) {
            calls.prompts.push(options);
            return complete ? complete(options) : {choices:[{text:'訳文',finish_reason:'stop'}]};
        }
        async exit() { calls.exits++; }
    }
    const exports = {};
    new Function('exports','require','WebAssembly','navigator',compile('src/core/wllama_translation.ts'))(
        exports, name => name === '@wllama/wllama' ? {Wllama} : name.endsWith('.wasm') ? {__esModule:true,default:'bundled.wasm'} : name === 'hachiue' ? hachiue : shared,
        {Memory:class {}, ...(jspi ? {Suspending:class {}} : {})}, {gpu:{requestAdapter:async()=>({})}}
    );
    return {...exports,calls};
}
test('wllama uses selected GGUF, bundled WASM, GPU offload and the PLaMo prompt', async () => {
    const api = await setup();
    const controller = new AbortController();
    const translator = await api.createWllamaTranslator(controller.signal, () => {}, '2b-q4_k_m');
    assert.match(api.calls.url, /2b-Q4_K_M.gguf$/);
    assert.equal(api.calls.paths.default, 'bundled.wasm');
    assert.equal(api.calls.compat, null);
    assert.equal(api.calls.loadOptions.n_gpu_layers, 99999);
    assert.equal(await translator.translate('Hello'), '訳文');
    assert.match(api.calls.prompts[0].prompt, /<\|plamo:bos\|>/);
    assert.ok(api.calls.prompts[0].prompt.includes('Hello'));
    assert.equal(api.calls.prompts[0].abortSignal, controller.signal);
    await translator.destroy();
    controller.abort();
    assert.equal(api.calls.exits, 1);
});
test('failed loading releases the worker', async () => {
    const api = await setup({load:async()=>{throw Error('load failed');}});
    await assert.rejects(api.createWllamaTranslator(new AbortController().signal,()=>{}), /load failed/);
    assert.equal(api.calls.exits, 1);
});
test('abort discards generated text and releases the worker', async () => {
    const controller = new AbortController();
    const api = await setup({complete:async()=>{controller.abort();return {choices:[{text:'partial',finish_reason:'stop'}]};}});
    const translator = await api.createWllamaTranslator(controller.signal,()=>{});
    await assert.rejects(translator.translate('Hello'), {name:'AbortError'});
    assert.equal(api.calls.exits,1);
    await translator.destroy();
});
test('incomplete generations are rejected', async () => {
    const api = await setup({complete:async()=>({choices:[{text:'partial',finish_reason:'length'}]})});
    const translator = await api.createWllamaTranslator(new AbortController().signal,()=>{});
    await assert.rejects(translator.translate('Hello'), /incomplete/);
    await translator.destroy();
});
test('missing JSPI fails before downloading a model', async () => {
    const api = await setup({jspi:false});
    await assert.rejects(api.createWllamaTranslator(new AbortController().signal,()=>{}), /JSPI/);
    assert.equal(api.calls.url,undefined);
});
