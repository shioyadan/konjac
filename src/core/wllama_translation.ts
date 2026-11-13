import {Wllama} from "@wllama/wllama";
import wasmURL from "@wllama/wllama/esm/wasm/wllama.wasm";
import {buildPlamo3TranslationPrompt, extractCleanTextTranslation, type LoadProgress} from "hachiue";
import {translationChunks, translationModelURL, WEBGPU_MODELS} from "./webgpu_translation";

export async function createWllamaTranslator(signal: AbortSignal, onProgress: (progress: LoadProgress) => void, modelId: string = WEBGPU_MODELS[0].id) {
    let url = translationModelURL(modelId);
    signal.throwIfAborted();
    // CDNの互換ランタイムへ切り替わらないよう、同梱WASMの必要機能を先に確認する。
    if (!("Suspending" in WebAssembly)) {
        throw new Error("wllama requires WebAssembly JSPI. Use a recent Chrome/Edge or select hachiue.");
    }
    try {
        new WebAssembly.Memory({address: "i64", initial: 1n} as unknown as WebAssembly.MemoryDescriptor);
    }
    catch {
        throw new Error("wllama requires WebAssembly Memory64. Select hachiue in this browser.");
    }
    if (!navigator.gpu || !await navigator.gpu.requestAdapter()) {
        throw new Error("No WebGPU adapter is available.");
    }
    signal.throwIfAborted();
    let engine = new Wllama({default: wasmURL}, {allowOffline: true});
    engine.setCompat(null);
    let abort = () => { void engine.exit().catch((error) => console.warn("Failed to stop wllama", error)); };
    signal.addEventListener("abort", abort, {once: true});
    try {
        onProgress({phase: "weights", message: "Loading wllama model…"});
        await engine.loadModelFromUrl(url, {
            n_ctx: 4096, n_gpu_layers: 99999, n_threads: 1, n_parallel: 1,
            ctx_shift: false, signal,
            progressCallback: ({loaded, total}) => onProgress({
                phase: "weights", loadedBytes: loaded, totalBytes: total,
                message: loaded < total ? "Downloading wllama model…" : "Preparing wllama GPU…"
            })
        });
        signal.throwIfAborted();
        let info = engine.getLoadedContextInfo();
        if (!info.n_vocab || info.metadata["general.architecture"] !== "plamo3") {
            throw new Error("wllama could not load the PLaMo 3 model.");
        }
        return {
            async translate(text: string) {
                let translated: string[] = [];
                for (let chunk of translationChunks(text)) {
                    signal.throwIfAborted();
                    if (!chunk.trim()) { translated.push(chunk); continue; }
                    // hachiueと同じPFML3プロンプトを使い、推論エンジンだけを切り替える。
                    let result = await engine.createCompletion({
                        prompt: buildPlamo3TranslationPrompt({input: chunk.trim(), sourceLang: "en", targetLang: "ja", form: "plain"}),
                        max_tokens: 1536, temperature: 0, stop: ["<|plamo:eom|>"], abortSignal: signal
                    });
                    signal.throwIfAborted();
                    let choice = result.choices[0];
                    let output = extractCleanTextTranslation(choice?.text ?? "");
                    if (!output.trim() || choice.finish_reason !== "stop") {
                        throw new Error("The model returned an empty or incomplete translation. Please retry this block.");
                    }
                    translated.push(output);
                }
                return translated.join(" ");
            },
            async destroy() { signal.removeEventListener("abort", abort); await engine.exit(); }
        };
    }
    catch (error) {
        signal.removeEventListener("abort", abort);
        await engine.exit();
        throw error;
    }
}
