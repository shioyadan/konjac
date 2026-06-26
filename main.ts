"use strict";

const ID_KONJAC = "ID_KONJAC";
const CONTEXT_MENU_PROPS = {
    "title": "View PDF",
    "contexts": ["all"] as ["all"]
};

function createContextMenu() {
    chrome.contextMenus.update(ID_KONJAC, CONTEXT_MENU_PROPS, () => {
        if (!chrome.runtime.lastError) {
            return;
        }

        chrome.contextMenus.create({
            "id": ID_KONJAC,
            ...CONTEXT_MENU_PROPS
        }, () => {
            let error = chrome.runtime.lastError;
            if (error) {
                console.warn(`Failed to create context menu: ${error.message}`);
            }
        });
    });
}

function safeDecodeURIComponent(text: string) {
    try {
        return decodeURIComponent(text);
    }
    catch {
        return text;
    }
}

function sanitizeDownloadFileName(fileName: string) {
    let sanitized = fileName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
    sanitized = sanitized.replace(/^[. ]+|[. ]+$/g, "");
    if (sanitized == "") {
        sanitized = "download";
    }
    if (!/\.pdf$/i.test(sanitized)) {
        sanitized += ".pdf";
    }
    return sanitized;
}

function suggestedPDFFileName(urlText: string) {
    try {
        let url = new URL(urlText);
        let lastPathPart = url.pathname.split("/").filter((part) => part != "").pop();
        if (lastPathPart) {
            return sanitizeDownloadFileName(safeDecodeURIComponent(lastPathPart));
        }
    }
    catch {
        let lastPathPart = urlText.split(/[\\/]/).filter((part) => part != "").pop();
        if (lastPathPart) {
            return sanitizeDownloadFileName(lastPathPart);
        }
    }
    return "download.pdf";
}

function encodePathSegments(path: string) {
    return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function filePathToURL(filePath: string) {
    let normalized = filePath.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
        return `file:///${normalized[0]}:${encodePathSegments(normalized.slice(2))}`;
    }
    if (normalized.startsWith("/")) {
        return `file://${encodePathSegments(normalized)}`;
    }
    return normalized;
}

function main() {
    // service worker が再起動しても同じ id のメニューを重複作成しない。
    createContextMenu();

    // クリックハンドラの登録
    chrome.contextMenus.onClicked.addListener(async (info) => {
        if (info.menuItemId == ID_KONJAC) {
            const viewerURL = chrome.runtime.getURL("viewer.html");

            let orgURL: string|undefined = "";
            if (info?.frameUrl) {
                orgURL = info.frameUrl;
            }
            else if (info?.pageUrl) {
                orgURL = info.pageUrl;
            }

            if (!orgURL) {
                console.log(`Invalid URL: ${orgURL}`);
                return;
            }

            // let response = await fetch(orgURL);
            // let blobResponse = await response.blob();

            // PDF ファイルを１回ダウンロードしてから開く。URL 由来の名前を安全なファイル名にして使う。
            let id = await chrome.downloads.download({
                url: orgURL,
                filename: suggestedPDFFileName(orgURL),
                conflictAction: "uniquify"
            });
            let openDownloadedPDF = async (delta: chrome.downloads.DownloadDelta) => {
                if (delta.id == id && delta.state && delta.state.current == "complete") {
                    chrome.downloads.onChanged.removeListener(openDownloadedPDF);
                    let result = await chrome.downloads.search({id: id});
                    if (!result[0]?.filename) {
                        console.warn(`Downloaded PDF not found: ${id}`);
                        return;
                    }
                    const pdfURL = encodeURIComponent(filePathToURL(result[0].filename));
                    const tabURL = `${viewerURL}?file=${pdfURL}`;
                    chrome.tabs.create({url: tabURL});
                    console.log(`Open a new tab: ${tabURL}`);
                }
            };
            chrome.downloads.onChanged.addListener(openDownloadedPDF);
        }
    });
}

main();
