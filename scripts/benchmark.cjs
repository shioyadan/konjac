#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {createHash} = require('node:crypto');
const {parseArgs} = require('node:util');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

function parse(argv) {
    const {values, positionals} = parseArgs({args:argv, allowPositionals:true, options:{
        input:{type:'string'}, engine:{type:'string',default:'both'}, model:{type:'string',default:'0.8b-q4_0'},
        runs:{type:'string',default:'3'}, warmup:{type:'string',default:'1'},
        profile:{type:'string',default:path.join(os.homedir(),'.cache','konjac','benchmark')},
        port:{type:'string',default:'8767'}, timeout:{type:'string',default:'1800'},
        'browser-path':{type:'string'}, headed:{type:'boolean'}, probe:{type:'boolean'},
        'allow-software-gpu':{type:'boolean'}, help:{type:'boolean',short:'h'}
    }});
    if (positionals.length) throw new Error('Use --input <text-file or translation.json>.');
    if (values.help) return values;
    for (const [key,min,max] of [['runs',1,100],['warmup',0,100],['port',1,65535],['timeout',1,86400]]) {
        if (!/^\d+$/.test(values[key]) || +values[key] < min || +values[key] > max) throw new Error(`Invalid --${key}`);
        values[key] = Number(values[key]);
    }
    if (!['both','hachiue','wllama'].includes(values.engine)) throw new Error('Invalid --engine');
    if (!['0.8b-q4_0','2b-q4_0','2b-q4_k_m'].includes(values.model)) throw new Error('Invalid --model');
    if (!values.probe && !values.input) throw new Error('--input is required (or use --probe).');
    return values;
}
function readTexts(file) {
    const source=fs.readFileSync(file,'utf8');
    let texts;
    if (/\.json$/i.test(file)) {
        const data=JSON.parse(source);
        if (!Array.isArray(data.blocks) || data.blocks.some(block=>typeof block.source !== 'string')) throw new Error('Expected translation JSON with blocks[].source.');
        texts=data.blocks.map(block=>block.source);
    } else texts=source.split(/\r?\n\s*\r?\n/);
    texts=texts.map(text=>text.trim()).filter(Boolean);
    if (!texts.length) throw new Error('Input contains no text.');
    return texts;
}
async function main(argv=process.argv.slice(2)) {
    const options=parse(argv);
    if (options.help) {
        console.log(`Usage: bin/konjac benchmark --input text.txt [options] > results.json
  --input <file>       UTF-8 text (blank-line-separated paragraphs) or translation JSON
  --engine <name>      both (default), hachiue, wllama
  --model <id>         0.8b-q4_0 (default), 2b-q4_0, 2b-q4_k_m
  --runs <n>          Measured repetitions (default: 3)
  --warmup <n>        Unmeasured repetitions (default: 1)
  --browser-path <p>  Chrome/Chromium executable; default: installed Chrome
  --headed           Show the browser window
  --profile <dir>     Persistent benchmark-only profile (~/.cache/konjac/benchmark)
  --port <n>          Localhost origin port (default: 8767; keep fixed to reuse caches)
  --timeout <seconds> Timeout per engine including loading (default: 1800)
  --probe            Report browser/GPU environment without downloading weights
  --allow-software-gpu  Allow software adapters; results are not hardware GPU benchmarks
Requires Node.js 20+. Build with make benchmark-build first. Progress: stderr; results: stdout.`);
        return;
    }
    if (+process.versions.node.split('.')[0] < 20) throw new Error('Benchmark requires Node.js 20+. Set KONJAC_NODE to a supported Node executable.');
    const texts=options.probe ? [] : readTexts(options.input);
    const assets=path.join(root,'dist','benchmark');
    if (!fs.existsSync(path.join(assets,'benchmark.js'))) {
        const result=spawnSync('make',['benchmark-build'],{cwd:root,stdio:['inherit',2,2]});
        if (result.status !== 0) throw new Error('Benchmark build failed.');
    }
    const server=http.createServer((req,res)=>{
        const name=req.url?.split('?')[0];
        if (name==='/') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><script src="/benchmark.js"></script>'); return; }
        if (!['/benchmark.js','/wllama.wasm'].includes(name)) {res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':'text/javascript');
        fs.createReadStream(path.join(assets,name.slice(1))).on('error',()=>res.destroy()).pipe(res);
    });
    let context;
    try {
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port,'127.0.0.1',resolve);});
        const {chromium}=require('playwright-core');
        const launch={headless:!options.headed,args:['--enable-unsafe-webgpu']};
        if (options['browser-path']) launch.executablePath=path.resolve(options['browser-path']);
        else launch.channel='chrome';
        context=await chromium.launchPersistentContext(path.resolve(options.profile),launch);
        const page=await context.newPage();
        await page.goto(`http://127.0.0.1:${options.port}/`);
        await page.waitForFunction(()=>window.konjacBenchmark);
        const environment=await page.evaluate(()=>window.konjacBenchmark.environment());
        environment.browserVersion=context.browser()?.version() ?? null;
        const software=environment.adapter.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(JSON.stringify(environment.adapter));
        if (software && !options['allow-software-gpu']) throw new Error('Software GPU detected. Use a hardware GPU, or explicitly pass --allow-software-gpu for diagnostics.');
        const report={schemaVersion:1,createdAt:new Date().toISOString(),environment,softwareAdapter:software,
            versions:{hachiue:require('../package.json').dependencies.hachiue,wllama:require('../package.json').dependencies['@wllama/wllama']},
            settings:options,input:options.probe?null:{sha256:createHash('sha256').update(JSON.stringify(texts)).digest('hex'),blocks:texts.length},
            cache:'Persistent profile; loadMs includes cache lookup/download, shader compilation and GPU upload. Cache warmth is not inferred.',
            results:[]};
        await page.close();
        for (const engine of options.probe?[]:options.engine==='both'?['hachiue','wllama']:[options.engine]) {
            console.error(`Benchmark: ${engine} / ${options.model} (loading, ${options.warmup} warmup, ${options.runs} runs)`);
            let timer;
            const runPage=await context.newPage();
            try {
                await runPage.goto(`http://127.0.0.1:${options.port}/`);
                await runPage.waitForFunction(()=>window.konjacBenchmark);
                const result=await Promise.race([
                    runPage.evaluate(opts=>window.konjacBenchmark.run(opts),{engine,model:options.model,texts,runs:options.runs,warmup:options.warmup}),
                    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Engine timed out')),options.timeout*1000);})
                ]);
                report.results.push(result);
                console.error(`${engine}: load ${result.loadMs.toFixed(0)} ms; median translation ${result.medianMs.toFixed(0)} ms`);
            } catch(error) {
                report.results.push({engine,model:options.model,error:String(error.message ?? error)});
                process.exitCode=1;
            } finally {
                clearTimeout(timer);
                // Closing the page also terminates workers and GPU resources on timeout.
                await runPage.close().catch(()=>{});
            }
        }
        console.log(JSON.stringify(report,null,2));
    } finally {
        if(context) await context.close();
        await new Promise(resolve=>server.close(resolve));
    }
}
module.exports={parse,readTexts,main};
if(require.main===module) main().catch(error=>{console.error(`konjac benchmark: ${error.message}`);process.exitCode=1;});
