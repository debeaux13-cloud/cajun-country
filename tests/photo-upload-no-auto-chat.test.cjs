const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

test('photo upload does not automatically start Stage chat',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','pages','create.js'),'utf8');
  assert.doesNotMatch(source,/talkToStage\('',readyImage,\[\]\)/);
  assert.match(source,/Photo ready\. Tell Stage your idea or choose a story type\./);
  assert.match(source,/onClick=\{\(\)=>talkToStage\(\)\}/);
});
