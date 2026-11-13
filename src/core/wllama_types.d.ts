import type {Console as NodeConsole} from "node:console";

// wllama 3.13.0の公開型が旧Node型定義のグローバル名前空間を参照する。
declare global {
    namespace console {
        type Console = NodeConsole;
        type ConsoleConstructor = typeof NodeConsole;
    }
}
