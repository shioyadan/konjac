run:
	node main.js


init:
	npm install

clean:
	rm dist/*.js -f
	rm packaging-work -r -f

distclean: clean
	rm node_modules -r -f
