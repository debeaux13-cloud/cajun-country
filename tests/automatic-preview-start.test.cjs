const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'..','pages','create.js'),'utf8');

test('successful Stage starts Preview exactly once with the returned draft',()=>{
  assert.match(source,/const draft=\{attempt:resolvedAttempt/);
  assert.match(source,/await preview\(draft\);/);
  assert.equal((source.match(/await preview\(draft\);/g)||[]).length,1);
  assert.match(source,/async function preview\(createdStory\)/);
  assert.match(source,/const draft=createdStory\|\|selectedDraft;/);
});

test('the client guard prevents repeated render submissions',()=>{
  assert.match(source,/if\(previewRequest\.current\)return;/);
  assert.match(source,/previewRequest\.current=true;/);
  assert.match(source,/if\(!response\.ok\)throw new Error/);
  assert.doesNotMatch(source,/>Preview My Movie Free/);
});
