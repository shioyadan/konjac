PDF ?= work/test.pdf
OUT ?= work/test.html
JSON_OUT ?= work/test.json

# cmaps ファイルは webpack で埋め込めないため，コピーしておく
all:
	npx webpack --config=webpack.config.cjs
	cp node_modules/pdfjs-dist/cmaps dist/cmaps -r

cli-build:
	npx webpack --config=webpack.cli.config.cjs

cli: cli-build
	mkdir -p "$(dir $(OUT))"
	node dist/cli.cjs "$(PDF)" > "$(OUT)"

cli-json: cli-build
	mkdir -p "$(dir $(JSON_OUT))"
	node dist/cli.cjs --json "$(PDF)" > "$(JSON_OUT)"

init: package.json
	npm install

clean:
	rm dist -r -f

distclean: clean
	rm node_modules -r -f

