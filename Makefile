all: 
	npx webpack --config=webpack.config.cjs
	cp node_modules/pdfjs-dist/cmaps dist/cmaps -r 

# npx tsc


# Bundle external libraries into a single file (dist/external_modules.js)
dist/external_modules.js: external_modules_src.js webpack.config.cjs
	rm dist/*.js -f
	npx webpack --config=webpack.config.cjs



init: package.json
	npm install

clean:
	rm dist -r -f
	rm packaging-work -r -f

distclean: clean
	rm node_modules -r -f

