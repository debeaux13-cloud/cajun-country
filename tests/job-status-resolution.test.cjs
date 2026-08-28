const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const MCS_ID='11111111-1111-4111-8111-111111111111';
function response(status,payload={}){return{ok:status>=200&&status<300,status,json:async()=>payload};}
function loadHandler({claim,statusCode=200,statusPayload={},storedMovie=false}){
  const filename=path.join(__dirname,'..','pages','api','job.js');
  const source=fs.readFileSync(filename,'utf8')
    .replace("import{head}from'@vercel/blob';","const {head}=blob;")
    .replace("import{runpod}from'./_runpod';","const {runpod}=runpodModule;")
    .replace("import{getPreviewClaimByMcsJobId}from'../../lib/preview-guard';","const {getPreviewClaimByMcsJobId}=claimModule;")
    .replace('export default async function handler','async function handler')+'\nmodule.exports=handler;';
  const calls=[];
  const blob={head:async()=>{if(!storedMovie)throw new Error('missing');return{contentType:'video/mp4',size:524288};}};
  const context={module:{exports:{}},blob,process:{env:{BLOB_READ_WRITE_TOKEN:'blob-token'}},String,JSON,console:{log:()=>{}},encodeURIComponent,fetch:async(url,options={})=>{
    calls.push({url,options});
    if(url.includes('/status/'))return response(statusCode,statusPayload);
    throw new Error('only status calls are allowed');
  },runpodModule:{runpod:()=>({key:'worker-key',base:'https://worker.test'})},claimModule:{getPreviewClaimByMcsJobId:async id=>{assert.equal(id,MCS_ID);return claim;}}};
  vm.runInNewContext(source,context,{filename});
  return{handler:context.module.exports,calls};
}
async function request(fixture){
  const env=loadHandler(fixture); const res={code:0,body:null,status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await env.handler({query:{jobId:'OLD_JOB',mcsJobId:MCS_ID}},res);
  return{...env,res};
}
function assertNoPaidCalls(calls){
  assert.equal(calls.filter(call=>/\/run|\/cancel|runway|elevenlabs|stripe/i.test(call.url)).length,0);
}

test('stale browser job resolves to current claim job and queries only the new status ID',async()=>{
  const result=await request({claim:{mcsJobId:MCS_ID,jobId:'NEW_JOB',status:'submitted'},statusPayload:{status:'IN_PROGRESS',output:{}}});
  assert.equal(result.res.code,200);
  assert.equal(result.res.body.requestedJobId,'OLD_JOB');
  assert.equal(result.res.body.resolvedJobId,'NEW_JOB');
  assert.equal(result.res.body.jobIdChanged,true);
  assert.equal(result.res.body.status,'IN_PROGRESS');
  assert.deepEqual(result.calls.map(call=>call.url),['https://worker.test/status/NEW_JOB']);
  assertNoPaidCalls(result.calls);
});

test('manual-review claim is terminal and does not contact RunPod or alter preview assets',async()=>{
  const result=await request({claim:{mcsJobId:MCS_ID,jobId:'NEW_JOB',status:'manual_review',failureMessage:'Needs review'}});
  assert.equal(result.res.code,200);
  assert.equal(result.res.body.status,'MANUAL_REVIEW');
  assert.equal(result.res.body.resolvedJobId,'NEW_JOB');
  assert.equal(result.calls.length,0);
});

test('missing resolved job without a stored movie is terminal instead of returning a 502 polling loop',async()=>{
  const result=await request({claim:{mcsJobId:MCS_ID,jobId:'NEW_JOB',status:'submitted'},statusCode:404,statusPayload:{error:'missing'}});
  assert.equal(result.res.code,200);
  assert.equal(result.res.body.status,'FAILED');
  assert.equal(result.res.body.providerStatus,'NOT_FOUND');
  assert.equal(result.res.body.resolvedJobId,'NEW_JOB');
  assertNoPaidCalls(result.calls);
});

test('expired RunPod job with a stored preview movie stays completed',async()=>{
  const result=await request({claim:{mcsJobId:MCS_ID,jobId:'NEW_JOB',status:'submitted'},statusCode:404,statusPayload:{error:'missing'},storedMovie:true});
  assert.equal(result.res.code,200);
  assert.equal(result.res.body.status,'COMPLETED');
  assert.equal(result.res.body.providerStatus,'NOT_FOUND');
  assert.equal(result.res.body.storedPreviewReady,true);
  assert.equal(result.res.body.videoUrl,'/api/preview-media?id='+MCS_ID);
  assertNoPaidCalls(result.calls);
});

test('completed resolved job preserves existing video completion response',async()=>{
  const result=await request({claim:{mcsJobId:MCS_ID,jobId:'NEW_JOB',status:'submitted'},statusPayload:{status:'COMPLETED',output:{status:'ready',videoUrl:'https://video.test/preview.mp4'}}});
  assert.equal(result.res.code,200);
  assert.equal(result.res.body.status,'COMPLETED');
  assert.equal(result.res.body.resolvedJobId,'NEW_JOB');
  assert.equal(result.res.body.videoUrl,'https://video.test/preview.mp4');
  assertNoPaidCalls(result.calls);
});
