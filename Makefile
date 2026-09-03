PDF ?= work/test.pdf
OUT ?= work/test.html
JSON_OUT ?= work/test.json
TRANSLATION_JSON_OUT ?= work/test.translation.json
TRANSLATION_JSON_IN ?= work/test.translation.json
TRANSLATED_HTML_OUT ?= work/test.translated.html
WEB_HOST ?= 127.0.0.1
WEB_PORT ?= 8765

.PHONY: all typecheck extension-build web-build web-serve cli-build package cli cli-json cli-translation-json cli-import init clean distclean

# 拡張版はCMapをディレクトリとして同梱し、Web版は単一HTMLへ埋め込む
all: extension-build web-build cli-build

typecheck:
	npx tsc --noEmit
	npx tsc --project jsconfig.json --noEmit

extension-build:
	npx webpack --config=webpack.config.cjs --mode=production
	mkdir -p dist/extension/cmaps
	cp -r node_modules/pdfjs-dist/cmaps/. dist/extension/cmaps
	cp src/extension/manifest.json dist/extension/manifest.json
	cp src/extension/viewer.html dist/extension/viewer.html

web-build:
	npx webpack --config=webpack.web.config.cjs --mode=production

# Web版をビルドし、File System Access APIを利用できるlocalhostで配信する
web-serve: web-build
	python3 -m http.server "$(WEB_PORT)" --bind "$(WEB_HOST)" --directory dist/web

# Web版とChrome拡張を、そのまま配布できる独立したZIPにする
package: extension-build web-build
	mkdir -p dist/packages
	cd dist/web && zip -q -r -FS ../packages/konjac-web.zip .
	cd dist/extension && zip -q -r -FS ../packages/konjac-extension.zip .

cli-build:
	npx webpack --config=webpack.cli.config.cjs
	cp node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs dist/cli/pdf.worker.mjs
	cp bin/konjac dist/cli/konjac
	chmod +x dist/cli/konjac

cli: cli-build
	mkdir -p "$(dir $(OUT))"
	node dist/cli/cli.cjs "$(PDF)" > "$(OUT)"

cli-json: cli-build
	mkdir -p "$(dir $(JSON_OUT))"
	node dist/cli/cli.cjs --json "$(PDF)" > "$(JSON_OUT)"

cli-translation-json: cli-build
	mkdir -p "$(dir $(TRANSLATION_JSON_OUT))"
	node dist/cli/cli.cjs --translation-json "$(PDF)" > "$(TRANSLATION_JSON_OUT)"

cli-import: cli-build
	mkdir -p "$(dir $(TRANSLATED_HTML_OUT))"
	node dist/cli/cli.cjs --import-translation "$(TRANSLATION_JSON_IN)" "$(PDF)" > "$(TRANSLATED_HTML_OUT)"

init: package.json
	npm install

clean:
	rm dist -r -f

distclean: clean
	rm node_modules -r -f

