const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
test('Preview pipeline derives worker asset origin from VERCEL_URL',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','pages','api','internal','preview-pipeline','[id].js'),'utf8');
 assert.match(source,/previewCallbackBase\(\)/);
 assert.match(source,/api\/internal\/preview-pipeline\/\$\{id\}\/asset/);
 assert.doesNotMatch(source,/const origin='https:\/\/main-character-studios\.vercel\.app'/);
});
