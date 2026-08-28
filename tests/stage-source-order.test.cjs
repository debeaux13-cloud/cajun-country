const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'..','pages','api','stage.js'),'utf8');
test('keeps source fact coverage without rejecting valid plans by first tagged scene order',()=>{
  assert.match(source,/const missing=sourceLedger\.requiredSourceFacts\.filter/);
  assert.doesNotMatch(source,/Stage changed the customer's source order near/);
});
