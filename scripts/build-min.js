'use strict';

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');

function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '') // remove comments
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/\s*([{}:;,])\s*/g, '$1') // remove spaces around symbols
    .replace(/;\}/g, '}') // remove trailing semicolons
    .trim();
}

function minifyJS(js) {
  // Safe JS whitespace & comment stripping minifier
  return js
    .replace(/\/\*[\s\S]*?\*\//g, '') // remove multi-line comments
    .replace(/^\s*\/\/.*$/gm, '') // remove single line comments
    .replace(/\n+/g, '\n') // collapse blank lines
    .trim();
}

try {
  console.log('Building minified production assets...');
  
  const cssPath = path.join(publicDir, 'styles.css');
  const cssMinPath = path.join(publicDir, 'styles.min.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const minCSS = minifyCSS(cssContent);
  fs.writeFileSync(cssMinPath, minCSS, 'utf8');
  console.log(`Minified styles.css: ${cssContent.length} B -> ${minCSS.length} B (${Math.round((1 - minCSS.length / cssContent.length) * 100)}% reduction)`);

  const jsPath = path.join(publicDir, 'app.js');
  const jsMinPath = path.join(publicDir, 'app.min.js');
  const jsContent = fs.readFileSync(jsPath, 'utf8');
  const minJS = minifyJS(jsContent);
  fs.writeFileSync(jsMinPath, minJS, 'utf8');
  console.log(`Minified app.js: ${jsContent.length} B -> ${minJS.length} B (${Math.round((1 - minJS.length / jsContent.length) * 100)}% reduction)`);

  console.log('Build complete!');
} catch (e) {
  console.error('Build minification failed:', e);
  process.exit(1);
}
