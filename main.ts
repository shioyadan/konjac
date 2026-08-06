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

function isChromeExtensionURL(url: URL) {
    return url.protocol == "chrome-extension:";
}

function originalURLFromChromeExtensionURL(url: URL) {
    if (!isChromeExtensionURL(url)) {
        return "";
    }

    let originalURL = (value: string) => {
        try {
            let parsedURL = new URL(value);
            if (!isChromeExtensionURL(parsedURL)) {
                return parsedURL.toString();
            }
        }
        catch {
            return "";
        }
        return "";
    };

    for (let key of ["src", "file", "url"]) {
        let value = url.searchParams.get(key);
        if (value) {
            let parsedURL = originalURL(value);
            if (parsedURL) {
                return parsedURL;
            }
        }
    }

    // Chrome の PDF viewer は元 URL を名前なしの query として保持する場合がある。
    // 例: chrome-extension://.../index.html?file:///C:/path/document.pdf
    let rawQuery = url.search.slice(1);
    for (let value of [rawQuery, safeDecodeURIComponent(rawQuery)]) {
        let parsedURL = originalURL(value);
        if (parsedURL) {
            return parsedURL;
        }
    }

    return "";
}

function downloadableURL(urlText: string | undefined) {
    if (!urlText) {
        return "";
    }

    try {
        let url = new URL(urlText);
        let originalURL = originalURLFromChromeExtensionURL(url);
        if (originalURL) {
            return originalURL;
        }
        if (isChromeExtensionURL(url)) {
            return "";
        }
        return url.toString();
    }
    catch {
        return urlText;
    }
}

function firstDownloadableURL(urls: (string | undefined)[]) {
    for (let urlText of urls) {
        let url = downloadableURL(urlText);
        if (url) {
            return url;
        }
    }
    return "";
}

function pdfURLFromContext(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
    let directURL = firstDownloadableURL([info.linkUrl, info.srcUrl]);
    if (directURL) {
        return directURL;
    }

    let frameURL = firstDownloadableURL([info.frameUrl]);
    if (frameURL) {
        return frameURL;
    }

    return firstDownloadableURL([info.pageUrl, tab?.url]);
}

function queryPDFName(url: URL) {
    for (let key of ["filename", "file", "name"]) {
        let value = url.searchParams.get(key);
        if (value && /\.pdf$/i.test(value)) {
            return sanitizeDownloadFileName(safeDecodeURIComponent(value));
        }
    }

    return null;
}

function isGenericHandlerName(fileName: string) {
    return /\.(?:html?|jsp|php|aspx?|cgi)$/i.test(fileName) || /^get(?:JSP|PDF)?$/i.test(fileName);
}

function fallbackPDFFileName(url: URL) {
    let parts = [
        url.hostname.replace(/^www\./, ""),
        ...url.pathname.split("/").filter((part) => part != "" && !isGenericHandlerName(part))
    ];

    for (let [key, value] of url.searchParams) {
        if (!value || /^utm_/i.test(key) || key == "tp") {
            continue;
        }
        parts.push(`${key}-${value}`);
        if (parts.length >= 4) {
            break;
        }
    }

    return sanitizeDownloadFileName(parts.join("-") || "download");
}

function suggestedPDFFileName(urlText: string) {
    try {
        let url = new URL(urlText);
        let nameFromQuery = queryPDFName(url);
        if (nameFromQuery) {
            return nameFromQuery;
        }

        let lastPathPart = url.pathname.split("/").filter((part) => part != "").pop();
        if (lastPathPart && !isGenericHandlerName(lastPathPart)) {
            return sanitizeDownloadFileName(safeDecodeURIComponent(lastPathPart));
        }
        return fallbackPDFFileName(url);
    }
    catch {
        let lastPathPart = urlText.split(/[\\/]/).filter((part) => part != "").pop();
        if (lastPathPart && !isGenericHandlerName(lastPathPart)) {
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

function isLocalFileURL(urlText: string) {
    try {
        return new URL(urlText).protocol == "file:";
    }
    catch {
        return false;
    }
}

function viewerTabURL(viewerURL: string, pdfURL: string) {
    let url = new URL(viewerURL);
    url.searchParams.set("file", pdfURL);
    return url.toString();
}

function main() {
    // service worker が再起動しても同じ id のメニューを重複作成しない。
    createContextMenu();

    // クリックハンドラの登録
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId == ID_KONJAC) {
            const viewerURL = chrome.runtime.getURL("viewer.html");

            let orgURL = pdfURLFromContext(info, tab);

            if (!orgURL) {
                console.log("Invalid URL", {info, tabURL: tab?.url});
                return;
            }

            // 既にローカルにある PDF は再ダウンロードしない。同じ Downloads 内へ
            // 保存し直すと、元の名前に (2) などが付いたファイルで衝突し得る。
            if (isLocalFileURL(orgURL)) {
                const tabURL = viewerTabURL(viewerURL, orgURL);
                chrome.tabs.create({url: tabURL});
                console.log(`Open a new tab: ${tabURL}`);
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
                    const pdfURL = filePathToURL(result[0].filename);
                    const tabURL = viewerTabURL(viewerURL, pdfURL);
                    chrome.tabs.create({url: tabURL});
                    console.log(`Open a new tab: ${tabURL}`);
                }
            };
            chrome.downloads.onChanged.addListener(openDownloadedPDF);
        }
    });
}

main();
