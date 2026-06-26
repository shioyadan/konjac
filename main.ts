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

            // PDF ファイルを１回ダウンロードしてから開く
            let id = await chrome.downloads.download({url: orgURL, filename: "test.pdf"}); 
            chrome.downloads.onChanged.addListener(async (delta) => {
                if (delta.id == id && delta.state && delta.state.current == "complete") {
                    let result = await chrome.downloads.search({id: id}); 
                    const pdfURL = encodeURIComponent(result[0].filename);
                    const tabURL = `${viewerURL}?file=${pdfURL}`;
                    chrome.tabs.create({url: tabURL});
                    console.log(`Open a new tab: ${tabURL}`);
                }
            });
        }
    });
}

main();
