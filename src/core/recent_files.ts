"use strict";

const STORAGE_KEY = "konjac-recent-files";
export const MAX_RECENT_FILES = 10;

export interface RecentFile {
    key: string;
    name: string;
    source?: string;
    openedAt: number;
}

// 値がRecentFileとして利用できるか検証する。localStorageには旧形式や不正な値が入り得る。
function isRecentFile(value: unknown): value is RecentFile {
    if (!value || typeof value != "object") {
        return false;
    }
    let file = value as Partial<RecentFile>;
    return typeof file.key == "string" && typeof file.name == "string" &&
        (file.source === undefined || typeof file.source == "string") &&
        typeof file.openedAt == "number" && Number.isFinite(file.openedAt);
}

// localStorageから最近開いたファイルを取得する。読み出し失敗は空の履歴として扱う。
export function recentFiles() {
    try {
        let parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter(isRecentFile).slice(0, MAX_RECENT_FILES) : [];
    }
    catch {
        return [];
    }
}

// 最近開いたファイルを保存する。同じkeyは重複させず、閲覧時刻を更新して先頭へ移動する。
export function rememberRecentFile(file: Omit<RecentFile, "openedAt">) {
    let files = recentFiles().filter((recent) => recent.key != file.key);
    files = [{...file, openedAt: Date.now()}, ...files].slice(0, MAX_RECENT_FILES);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
    }
    catch {
        // file: URL やプライベートモードなど、保存領域が使えない環境でも表示は継続する。
    }
    return files;
}

// 最近開いたファイルの一覧を描画する。拡張とWeb版で表示を共有し、開き方だけを差し替える。
export function renderRecentFileList<T extends RecentFile>(openFile: (file: T) => void, files: readonly T[]) {
    let details = document.getElementById("recent-files");
    let list = document.getElementById("recent-file-list");
    if (!(details instanceof HTMLDetailsElement) || !(list instanceof HTMLUListElement)) {
        return;
    }

    details.hidden = files.length == 0;
    list.replaceChildren(...files.map((file) => {
        let button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.textContent = file.name;
        button.title = file.source ?? "";
        button.onclick = () => openFile(file);

        let time = document.createElement("time");
        time.dateTime = new Date(file.openedAt).toISOString();
        time.textContent = new Date(file.openedAt).toLocaleString();

        let item = document.createElement("li");
        item.append(button, time);
        return item;
    }));
}

// URLまたはパスから表示用のファイル名を得る。URLではパーセントエンコードも元に戻す。
export function recentFileName(source: string) {
    try {
        let url = new URL(source);
        let name = url.pathname.split("/").filter(Boolean).pop();
        return name ? decodeURIComponent(name) : source;
    }
    catch {
        return source.split(/[\\/]/).filter(Boolean).pop() ?? source;
    }
}
