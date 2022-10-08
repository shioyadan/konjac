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
    chrome.contextMenus.onClicked.addListener((info) => {
        if (info.menuItemId == ID_KONJAC) {
            const viewerURL = chrome.runtime.getURL("viewer.html");
            chrome.tabs.query({"active": true, "lastFocusedWindow": true}, (tabs) => {

                let orgURL = tabs[0].url;
                fetch(orgURL).then(response => {
                    response.blob().then(blobResponse => {

                        chrome.downloads.download({
                            url: orgURL,
                            filename: "test.pdf"
                        }, 
                        (id) => {

                            chrome.downloads.onChanged.addListener((delta) => {
                                if (delta.id == id && delta.state && delta.state.current == "complete") {
                                    chrome.downloads.search({id: id}, (result) => {
                                        const pdfURL = encodeURIComponent(result[0].filename);
                                        const tabURL = `${viewerURL}?file=${pdfURL}`;
                                        chrome.tabs.create({url: tabURL});
                                        console.log(tabURL);
                                    });
                                }
                            });


                        }
                    );

                        // const fileUrl = URL.createObjectURL(blobResponse)
                        // console.log(fileUrl);
                    })
                })
        

                // const pdfURL = encodeURIComponent(tabs[0].url);
                // const url = `${viewerURL}?file=${pdfURL}`;
                // chrome.tabs.create({url});
                // console.log(url);
            });
        }
    });
}

main();
