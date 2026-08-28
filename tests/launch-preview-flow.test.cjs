const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
test('one completed Stage request starts one Preview request with the returned story',()=>{
 const source=read('pages/create.js');
 assert.equal((source.match(/await preview\(draft\);/g)||[]).length,1);
 assert.match(source,/async function preview\(createdStory\)/);
 assert.match(source,/const draft=createdStory\|\|selectedDraft;/);
 assert.doesNotMatch(source,/>Preview My Movie Free/);
});
test('preview request remains content-bound and callback origin follows the active deployment',()=>{
 const preview=read('pages/api/preview.js');const callback=read('pages/api/internal/preview-pipeline/[id].js');
 assert.match(preview,/const callbackBase=previewCallbackBase\(\)/);
 assert.match(callback,/previewWorkerEnvironment\(\)\?previewCallbackBase\(\)/);
 assert.match(read('lib/preview-guard.js'),/requestHash/);
});
test('semantic source fact coverage is retained without scene-order rejection',()=>{
 const source=read('pages/api/stage.js');
 assert.match(source,/const missing=sourceLedger\.requiredSourceFacts\.filter/);
 assert.doesNotMatch(source,/Stage changed the customer's source order near/);
});
test('browser token and upload-ticket implementations are absent',()=>{
 const asset=read('pages/api/internal/preview-pipeline/[id]/asset.js');
 assert.doesNotMatch(asset,/token,storeId|apiUrl/);
 assert.equal(fs.existsSync(path.join(root,'pages/api/internal/preview-pipeline/[id]/upload-ticket.js')),false);
 assert.match(asset,/if\(!auth\(req\)\)return res\.status\(401\)/);
});
