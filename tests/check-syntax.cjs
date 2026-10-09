const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let count = 0;
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  new Function(match[1]);
  count++;
}
for (const file of ['google.js', 'shim.js', 'insights.js']) {
  new Function(fs.readFileSync(path.join(root, file), 'utf8'));
}
const markup = html.split('<script>')[0] + html.slice(html.indexOf('<body')).split('<script>')[0];
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'Hay IDs duplicados');
for (const match of html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css|svg))"/g)) {
  if (!match[1].includes('://')) assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
}
console.log(`OK: ${count} scripts inline, 3 archivos JS, IDs y recursos locales.`);
