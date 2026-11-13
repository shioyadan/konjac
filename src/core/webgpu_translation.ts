import {HachiueEngine, translateText, type LoadProgress} from "hachiue";

// 同じURLのモデルはhachiueのOPFS / IndexedDBキャッシュから再利用される。
export const WEBGPU_MODELS = [
    {id: "0.8b-q4_0", size: "0.8b", quant: "Q4_0", label: "PLaMo 3 Translate 0.8B Q4_0", mib: 522},
    {id: "2b-q4_0", size: "2b", quant: "Q4_0", label: "PLaMo 3 Translate 2B Q4_0", mib: 1620},
    {id: "2b-q4_k_m", size: "2b", quant: "Q4_K_M", label: "PLaMo 3 Translate 2B Q4_K_M", mib: 1723}
] as const;

export function translationModelURL(modelId: string): string {
    let model = WEBGPU_MODELS.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error("Unknown translation model.");
    return `https://huggingface.co/pfnet/plamo-3-translate-${model.size}-GGUF/resolve/main/plamo-3-translate-${model.size}-${model.quant}.gguf`;
}

export function translationChunks(text: string): string[] {
    let chunks: string[] = [];
    while (text.length > 600) {
        let prefix = text.slice(0, 600);
        let sentence = [...prefix.matchAll(/[.!?]\s+/g)].pop();
        let boundary = sentence && sentence.index! > 200 ? sentence : [...prefix.matchAll(/\s+/g)].pop();
        let end = boundary && boundary.index! > 200 ? boundary.index! + boundary[0].length : 600;
        // サロゲートペアを分断しない。
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        chunks.push(text.slice(0, end));
        text = text.slice(end);
    }
    if (text) chunks.push(text);
    return chunks;
}

export async function createWebGPUTranslator(signal: AbortSignal, onProgress: (progress: LoadProgress) => void, modelId: string = WEBGPU_MODELS[0].id) {
    let url = translationModelURL(modelId);
    if (!navigator.gpu) throw new Error("WebGPU requires a supported browser and HTTPS or localhost.");
    let adapter = await navigator.gpu.requestAdapter({powerPreference: "high-performance"});
    signal.throwIfAborted();
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    let device = await adapter.requestDevice({requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage
    }});
    try {
        signal.throwIfAborted();
        let engine = await HachiueEngine.create({url, backend: "webgpu", device, maxSeqLen: 4096, signal, onProgress});
        signal.throwIfAborted();
        return {
            async translate(text: string) {
                let translated: string[] = [];
                // GPUのKV cacheは共有されるため、必ず逐次推論する。
                for (let chunk of translationChunks(text)) {
                    signal.throwIfAborted();
                    if (!chunk.trim()) { translated.push(chunk); continue; }
                    let result = await translateText(engine, {
                        text: chunk, sourceLang: "en", targetLang: "ja", form: "plain",
                        maxNewTokens: 1536, temperature: 0, signal
                    });
                    signal.throwIfAborted();
                    if (!result.translation.trim() || result.stats.generatedTokens >= 1536 ||
                        result.stats.promptTokens + result.stats.generatedTokens >= engine.maxSeqLen) {
                        throw new Error("The model returned an empty or incomplete translation. Please retry this block.");
                    }
                    translated.push(result.translation);
                }
                return translated.join(" ");
            },
            destroy() { engine.dispose(); }
        };
    }
    catch (error) {
        device.destroy();
        throw error;
    }
}
