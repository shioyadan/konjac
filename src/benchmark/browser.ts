import {createWebGPUTranslator, WEBGPU_MODELS} from "../core/webgpu_translation";
import {createWllamaTranslator} from "../core/wllama_translation";

type Engine = "hachiue" | "wllama";
interface Options {engine: Engine; model: string; texts: string[]; runs: number; warmup: number;}

async function environment() {
    let adapter = await navigator.gpu?.requestAdapter({powerPreference: "high-performance"});
    if (!adapter) throw new Error("No WebGPU adapter. Try --headed or a WebGPU-capable Chrome installation.");
    let info = adapter.info;
    return {
        userAgent: navigator.userAgent,
        adapter: {vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
            isFallbackAdapter: info.isFallbackAdapter},
        models: WEBGPU_MODELS.map(({id}) => id)
    };
}

async function run(options: Options) {
    if (!WEBGPU_MODELS.some(({id}) => id === options.model)) throw new Error("Unknown model.");
    const controller = new AbortController();
    let start = performance.now();
    let translator = await (options.engine === "hachiue" ? createWebGPUTranslator : createWllamaTranslator)(
        controller.signal, () => {}, options.model
    );
    let loadMs = performance.now() - start;
    try {
        const translateAll = async () => {
            let outputs: string[] = [];
            for (let text of options.texts) {
                let segments: string[] = [];
                for (let part of text.split(/(⟦math-\d+-\d+⟧)/g)) {
                    segments.push(/^⟦math-\d+-\d+⟧$/.test(part) || !part.trim() ? part : await translator.translate(part));
                }
                outputs.push(segments.join(""));
            }
            return outputs;
        };
        start = performance.now();
        for (let i = 0; i < options.warmup; i++) await translateAll();
        const warmupMs = performance.now() - start;
        const inputCharacters = options.texts.reduce((sum, text) => sum + Array.from(text).length, 0);
        let samples = [];
        for (let i = 0; i < options.runs; i++) {
            start = performance.now();
            const translations = await translateAll();
            const elapsedMs = performance.now() - start;
            samples.push({elapsedMs, inputCharactersPerSecond: inputCharacters * 1000 / elapsedMs, translations});
        }
        const sorted = samples.map(({elapsedMs}) => elapsedMs).sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        return {engine: options.engine, model: options.model, loadMs, warmupMs, inputCharacters, medianMs, samples};
    }
    finally { await translator.destroy(); }
}

Object.assign(window, {konjacBenchmark: {environment, run}});
