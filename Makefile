# cmaps ファイルは webpack で埋め込めないため，コピーしておく
all: 
	npx webpack --config=webpack.config.cjs
	cp node_modules/pdfjs-dist/cmaps dist/cmaps -r 

init: package.json
	npm install

clean:
	rm dist -r -f

distclean: clean
	rm node_modules -r -f

