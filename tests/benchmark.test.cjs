const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {parse,readTexts}=require('../scripts/benchmark.cjs');
test('invalid benchmark settings fail before launching a browser',()=>{
    for(const args of [[],['--input','x','--runs','0'],['--probe','--engine','unknown'],['--probe','--model','missing'],['--probe','--timeout','NaN'],['--probe','--port','0']]) {
        assert.throws(()=>parse(args));
    }
    assert.equal(parse(['--probe']).probe,true);
    assert.equal(parse(['--input','x','--warmup','0']).warmup,0);
});
test('text and exported translation JSON use original paragraphs only',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'konjac-benchmark-test-'));
    try {
        const textFile=path.join(dir,'text.txt'), jsonFile=path.join(dir,'source.json');
        fs.writeFileSync(textFile,'First line\ncontinued\n\nSecond paragraph\n');
        assert.deepEqual(readTexts(textFile),['First line\ncontinued','Second paragraph']);
        fs.writeFileSync(jsonFile,JSON.stringify({blocks:[{source:'Original',translation:'訳文'},{source:'  '}]}));
        assert.deepEqual(readTexts(jsonFile),['Original']);
        fs.writeFileSync(jsonFile,JSON.stringify({blocks:[{translation:'訳文'}]}));
        assert.throws(()=>readTexts(jsonFile),/blocks/);
        fs.writeFileSync(textFile,' \n\n');
        assert.throws(()=>readTexts(textFile),/no text/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
function browserBenchmark(fail=false) {
    const ts=require('typescript');
    const code=ts.transpileModule(fs.readFileSync('src/benchmark/browser.ts','utf8'),{
        compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
    }).outputText;
    const window={};let clock=0,destroyed=0;const inputs=[];
    const create=async()=>{
        clock+=20;
        return {translate:async text=>{inputs.push(text);clock+=10;if(fail)throw Error('inference failed');return 'translated';},destroy:async()=>{destroyed++;}};
    };
    new Function('exports','require','window','performance',code)({},()=>({
        WEBGPU_MODELS:[{id:'test'}],createWebGPUTranslator:create,createWllamaTranslator:create
    }),window,{now:()=>clock});
    return {api:window.konjacBenchmark,inputs,destroyed:()=>destroyed};
}
test('benchmark excludes loading/warmup and preserves math markers',async()=>{
    const {api,inputs,destroyed}=browserBenchmark();
    const result=await api.run({engine:'hachiue',model:'test',texts:['one','a⟦math-1-2⟧b'],warmup:1,runs:2});
    assert.equal(result.loadMs,20);
    assert.equal(result.warmupMs,30);
    assert.equal(result.medianMs,30);
    assert.equal(result.samples.length,2);
    assert.equal(inputs.length,9);
    assert.ok(inputs.every(text=>!text.includes('⟦')));
    assert.equal(result.samples[0].translations[1],'translated⟦math-1-2⟧translated');
    assert.equal(destroyed(),1);
});
test('benchmark releases the translator on inference failure',async()=>{
    const {api,destroyed}=browserBenchmark(true);
    await assert.rejects(api.run({engine:'wllama',model:'test',texts:['one'],warmup:0,runs:1}),/inference failed/);
    assert.equal(destroyed(),1);
});
