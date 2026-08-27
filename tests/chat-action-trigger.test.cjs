const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const createSource=fs.readFileSync(path.join(__dirname,'..','pages','create.js'),'utf8');
const stageSource=fs.readFileSync(path.join(__dirname,'..','pages','api','stage.js'),'utf8');

test('a ready AI chat action automatically starts complete story generation',()=>{
  assert.match(createSource,/text&&result\.readyToCreate/);
  assert.match(createSource,/await stage\(\{ideaOverride:nextIdea,skipClarification:true,trigger:'ai_chat'\}\)/);
  assert.match(createSource,/Send to Stage &amp; Create My Story/);
});

test('a clarification answer starts the same automatic path after Stage is ready',()=>{
  assert.match(createSource,/Answer Stage’s one question\. Your answer will start the story automatically\./);
  assert.match(createSource,/needsClarification&&!skipClarification/);
});

test('the server logs the autonomous Stage trigger at start, completion, and failure',()=>{
  assert.match(stageSource,/\[stage-automation\]/);
  assert.match(stageSource,/event:'started'/);
  assert.match(stageSource,/event:'completed'/);
  assert.match(stageSource,/event:'failed'/);
});
