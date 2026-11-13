// wllama 3.13.0の埋め込みWorkerをMV3で許可される同梱ファイルへ変換する。
// npmパッケージ自体は変更せず、更新で構造が変わった場合はビルドを失敗させる。
const ts = require('typescript');
module.exports = function(source) {
    const file = ts.createSourceFile('wllama.js', source, ts.ScriptTarget.Latest, true);
    const strings = new Map();
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            const value = declaration.initializer;
            if (ts.isIdentifier(declaration.name) && value &&
                (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
                strings.set(declaration.name.text, value.text);
            }
        }
    }
    function get(name) {
        if (!strings.has(name)) throw new Error(`wllama worker layout changed: ${name}`);
        return strings.get(name);
    }
    function replaceOnce(before, after) {
        if (source.split(before).length !== 2) throw new Error(`wllama worker call changed: ${before}`);
        source = source.replace(before, after);
    }
    const moduleCode = get('JSPI_STUB') + get('WLLAMA_EMSCRIPTEN_CODE');
    this.emitFile('wllama-worker.js', [
        'const RUN_OPTIONS = {pathConfig: {"wllama.wasm": new URL("wllama.wasm", self.location.href).href}, nbThread: 0, compat: false};',
        `function wModuleInit() { ${moduleCode.replace('var Module', 'var ___Module')}; return Module; }`,
        get('LLAMA_CPP_WORKER_CODE')
    ].join('\n'));
    this.emitFile('wllama-opfs-worker.js', get('OPFS_UTILS_WORKER_CODE'));
    replaceOnce('this.worker = createWorker(completeCode);',
        'if (this.nbThread !== 0 || this.resources.compat) throw new Error("Konjac bundles the single-thread JSPI worker only"); this.worker = new Worker(chrome.runtime.getURL("wllama-worker.js"), {type: "module"});');
    replaceOnce('const worker = createWorker(OPFS_UTILS_WORKER_CODE);',
        'const worker = new Worker(chrome.runtime.getURL("wllama-opfs-worker.js"), {type: "module"});');
    return source;
};
