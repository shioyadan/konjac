PDF ?= work/test.pdf
OUT ?= work/test.html
JSON_OUT ?= work/test.json

.PHONY: all extension-build web-build cli-build cli cli-json init clean distclean

# 拡張版はCMapをディレクトリとして同梱し、Web版は単一HTMLへ埋め込む
all: extension-build web-build cli-build

extension-build:
	npx webpack --config=webpack.config.cjs
	mkdir -p dist/extension/cmaps
	cp -r node_modules/pdfjs-dist/cmaps/. dist/extension/cmaps
	cp src/extension/manifest.json dist/extension/manifest.json
	cp src/extension/viewer.html dist/extension/viewer.html

web-build:
	npx webpack --config=webpack.web.config.cjs --mode=production

cli-build:
	npx webpack --config=webpack.cli.config.cjs
	cp node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs dist/cli/pdf.worker.mjs

cli: cli-build
	mkdir -p "$(dir $(OUT))"
	node dist/cli/cli.cjs "$(PDF)" > "$(OUT)"

cli-json: cli-build
	mkdir -p "$(dir $(JSON_OUT))"
	node dist/cli/cli.cjs --json "$(PDF)" > "$(JSON_OUT)"

init: package.json
	npm install

clean:
	rm dist -r -f

distclean: clean
	rm node_modules -r -f

