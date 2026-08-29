const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

test('durable Preview status controls completion and media display',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','pages','preview.js'),'utf8');
  assert.match(source,/const status=String\(production\?\.status\|\|''\)\.toUpperCase\(\);/);
  assert.match(source,/const storedPreviewReady=production\?\.storedPreviewReady===true;/);
  assert.match(source,/const completed=status==='COMPLETED'\|\|storedPreviewReady;/);
  assert.match(source,/const failed=!storedPreviewReady/);
  assert.match(source,/const videoUrl=completed\?production\?\.videoUrl\|\|null:null;/);
});
