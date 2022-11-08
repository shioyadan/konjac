"use strict";

const ID_KONJAC = "ID_KONJAC";

function main() {
    // コンテクストメニューの追加
    chrome.contextMenus.create({
        "id": ID_KONJAC,
        "title": "View PDF",
        "contexts": ["all"]
    });

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
