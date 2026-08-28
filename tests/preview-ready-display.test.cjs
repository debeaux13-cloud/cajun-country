const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

test('verified stored movie takes precedence over an expired worker status',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','pages','preview.js'),'utf8');
  assert.match(source,/const storedPreviewReady=job\?\.storedPreviewReady===true;/);
  assert.doesNotMatch(source,/const storedPreviewReady=production\?\.status==='ready'\|\|production\?\.stage==='ready;/);
  assert.match(source,/const completed=status==='COMPLETED'\|\|storedPreviewReady;/);
  assert.match(source,/const failed=!storedPreviewReady/);
  assert.match(source,/completed&&mcsJobId\?'\/api\/preview-media\?id='\+encodeURIComponent\(mcsJobId\)/);
});
