"use strict";

import {MAX_RECENT_FILES, type RecentFile} from "../core/recent_files";

const DATABASE_NAME = "konjac-file-history";
const STORE_NAME = "recent-files";

interface PersistentFileHandle extends FileSystemFileHandle {
    queryPermission?(descriptor?: {readonly mode: "read"}): Promise<PermissionState>;
    requestPermission?(descriptor?: {readonly mode: "read"}): Promise<PermissionState>;
}

export interface RecentFileHandle extends RecentFile {
    handle: FileSystemFileHandle;
}

// IndexedDB requestの結果をPromiseとして返し、呼び出し側でawaitできるようにする。
function requestResult<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// IndexedDB transactionの完了を待つ。個々のrequest成功後にもtransactionは失敗し得る。
function transactionFinished(transaction: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
}

// 履歴用のIndexedDBを開き、初回はobject storeを作成する。
function openDatabase() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        let request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME, {keyPath: "key"});
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 値が再読込可能なRecentFileHandleか検証する。IndexedDBには旧形式の値も残り得る。
function isRecentFileHandle(value: unknown): value is RecentFileHandle {
    if (!value || typeof value != "object") {
        return false;
    }
    let record = value as Partial<RecentFileHandle>;
    return typeof record.key == "string" && typeof record.name == "string" &&
        typeof record.openedAt == "number" &&
        typeof record.handle == "object" && record.handle !== null &&
        record.handle.kind == "file" && typeof record.handle.getFile == "function" &&
        typeof record.handle.isSameEntry == "function";
}

// IndexedDBからファイル履歴を読み、閲覧時刻順に上限件数まで返す。
export async function loadRecentFileHandles() {
    if (!("indexedDB" in globalThis)) {
        return [];
    }
    let database = await openDatabase();
    try {
        let transaction = database.transaction(STORE_NAME, "readonly");
        let finished = transactionFinished(transaction);
        let values = await requestResult<unknown[]>(transaction.objectStore(STORE_NAME).getAll());
        await finished;
        return values.filter(isRecentFileHandle)
            .sort((left, right) => right.openedAt - left.openedAt)
            .slice(0, MAX_RECENT_FILES);
    }
    finally {
        database.close();
    }
}

// ファイルハンドルを履歴へ保存する。isSameEntryで同名の別ファイルを区別する。
export async function rememberRecentFileHandle(handle: FileSystemFileHandle) {
    let previous = await loadRecentFileHandles();
    let matchingKey: string | undefined;
    for (let record of previous) {
        try {
            if (await handle.isSameEntry(record.handle)) {
                matchingKey = record.key;
                break;
            }
        }
        catch {
            // 削除された古いhandleは無視する。
        }
    }

    let record: RecentFileHandle = {
        key: matchingKey ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        handle,
        name: handle.name,
        openedAt: Date.now()
    };
    let files = [record, ...previous.filter((item) => item.key != matchingKey)].slice(0, MAX_RECENT_FILES);
    let retainedKeys = new Set(files.map((item) => item.key));
    let database = await openDatabase();
    try {
        let transaction = database.transaction(STORE_NAME, "readwrite");
        let finished = transactionFinished(transaction);
        let store = transaction.objectStore(STORE_NAME);
        store.put(record);
        previous.filter((item) => !retainedKeys.has(item.key)).forEach((item) => store.delete(item.key));
        await finished;
        return files;
    }
    finally {
        database.close();
    }
}

// 指定したファイル履歴をIndexedDBから削除する。移動・削除済みの項目の除去に使用する。
export async function removeRecentFileHandle(key: string) {
    let database = await openDatabase();
    try {
        let transaction = database.transaction(STORE_NAME, "readwrite");
        let finished = transactionFinished(transaction);
        transaction.objectStore(STORE_NAME).delete(key);
        await finished;
    }
    finally {
        database.close();
    }
}

// 保存済みhandleから現在のFileを取得する。権限が失効していれば再許可を要求する。
export async function readRecentFile(handle: FileSystemFileHandle, onPermissionNeeded?: () => void) {
    let persistentHandle = handle as PersistentFileHandle;
    let permission = await persistentHandle.queryPermission?.({mode: "read"}) ?? "granted";
    let granted = permission == "granted";
    if (permission == "prompt" && persistentHandle.requestPermission) {
        onPermissionNeeded?.();
        granted = await persistentHandle.requestPermission({mode: "read"}) == "granted";
    }
    if (!granted) {
        throw new Error(`Permission to read ${handle.name} was not granted.`);
    }
    return handle.getFile();
}

// 永続化可能なhandleを返すファイルpickerに対応しているか判定する。
export function supportsPersistentFilePicker() {
    return typeof (globalThis as typeof globalThis & {showOpenFilePicker?: unknown}).showOpenFilePicker == "function";
}

// 現在の環境で永続ファイル履歴を安全に使えるか判定する。既知の停止条件では無効化する。
export function supportsPersistentFileHistory() {
    // ChromiumはWSL UNC上のfile:ページから復元したhandleへのアクセスを完了できない。
    // Windows側file:、localhost、HTTPSでは同じFile System Accessフローを利用できる。
    return supportsPersistentFilePicker() && !(location.protocol == "file:" && location.hostname == "wsl.localhost");
}

// PDF選択用のpickerを開き、IndexedDBへ保存可能なFileSystemFileHandleを返す。
export async function pickPDFFileHandle() {
    let showOpenFilePicker = (globalThis as typeof globalThis & {
        showOpenFilePicker(options: unknown): Promise<readonly FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    let [handle] = await showOpenFilePicker.call(globalThis, {
        multiple: false,
        types: [{description: "PDF", accept: {"application/pdf": [".pdf"]}}]
    });
    return handle;
}
