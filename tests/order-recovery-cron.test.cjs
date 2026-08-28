const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const now=Date.now();
function response(status,payload={}){return{ok:status>=200&&status<300,status,json:async()=>payload};}
async function loadCron({claim,workerJob}){
  const source=fs.readFileSync(path.join(__dirname,'..','pages','api','cron','order-recovery.js'),'utf8')
    .replace("import crypto from 'crypto';","const crypto=require('crypto');")
    .replace("import {head,list,put} from '@vercel/blob';","const {head,list,put}=blob;")
    .replace("import {runpod} from '../_runpod';","const {runpod}=runpodModule;")
    .replace("import {ORDER_RECOVERY_STALE_MS,orderRecoveryReason} from '../../../lib/order-recovery-reason';","const {ORDER_RECOVERY_STALE_MS,orderRecoveryReason}=recovery;")
    .replace('export default async function handler','async function handler')+'\nmodule.exports=handler;';
  const writes=[]; const calls=[];
  const blob={
    head:async pathname=>{if(pathname.endsWith('preview-movie.bin'))throw new Error('missing');return{downloadUrl:pathname};},
    list:async({prefix})=>({blobs:prefix==='mcs/preview-claims/'?[{pathname:'mcs/preview-claims/a.json',uploadedAt:new Date(now).toISOString()}]:[]}),
    put:async(pathname,value)=>{writes.push({pathname,value:JSON.parse(value)});}
  };
  const context={module:{exports:{}},require,console:{info:()=>{},error:()=>{}},process:{env:{BLOB_READ_WRITE_TOKEN:'token',CRON_SECRET:'cron',MCS_WORKER_SECRET:'worker'}},Date,Math,JSON,String,Number,Set,Promise,URLSearchParams,Buffer,fetch:async(url,options={})=>{
    calls.push({url,options});
    if(url.startsWith('mcs/preview-claims/'))return response(200,claim);
    if(url.endsWith('/health'))return response(200,{ok:true});
    if(url.includes('/status/'))return response(200,workerJob);
    if(url.includes('/run'))return response(200,{id:'replacement-job',status:'IN_QUEUE'});
    if(url.includes('/cancel/'))return response(200,{});
    throw new Error('unexpected fetch '+url);
  },blob,runpodModule:{runpod:()=>({key:'key',base:'https://worker.test'})},recovery:{ORDER_RECOVERY_STALE_MS:20*60*1000,orderRecoveryReason:(job,latest,at=Date.now(),http=200)=>{if(http===404)return'provider_missing';if(String(job?.output?.status||'').toLowerCase()==='manual_review')return'worker_manual_review';if(['FAILED','CANCELLED','TIMED_OUT'].includes(String(job?.status||'').toUpperCase()))return'terminal_failed';return String(job?.status||'').toUpperCase()==='IN_PROGRESS'&&Number(job.executionTime)>20*60*1000?'stuck_in_progress':'';}}};
  vm.runInNewContext(source,context,{filename:'order-recovery.js'});
  return{handler:context.module.exports,calls,writes,claim};
}
async function run(fixture){const env=await loadCron(fixture);const res={statusCode:0,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};await env.handler({method:'GET',headers:{authorization:'Bearer cron'}},res);return{...env,res};}
const claim={mcsJobId:'preview-id',jobId:'job-id',status:'submitted',createdAt:new Date(now).toISOString()};

test('manual_review causes zero RunPod /run calls and persists manual-review state once',async()=>{
  const first=await run({claim,workerJob:{status:'COMPLETED',output:{status:'manual_review'}}});
  assert.equal(first.calls.filter(call=>call.url.includes('/run')).length,0);
  assert.equal(first.calls.filter(call=>call.url.includes('/cancel/')).length,0);
  assert.equal(first.writes.length,1);
  assert.equal(first.writes[0].value.status,'manual_review');
});

test('repeated cron execution leaves manual-review claim untouched',async()=>{
  const reviewed={...claim,status:'manual_review',manualReviewAt:new Date(now).toISOString()};
  const repeat=await run({claim:reviewed,workerJob:{status:'COMPLETED',output:{status:'manual_review'}}});
  assert.equal(repeat.calls.filter(call=>call.url.includes('/run')||call.url.includes('/cancel/')).length,0);
  assert.equal(repeat.writes.length,0);
});

test('recovery canary uses health only and creates zero RunPod jobs',async()=>{
  const result=await run({claim:{},workerJob:{}});
  assert.equal(result.calls.filter(call=>call.url.endsWith('/health')).length,1);
  assert.equal(result.calls.filter(call=>call.url.includes('/run')).length,0);
});

test('failed and truly stuck previews retain recovery behavior',async()=>{
  for(const workerJob of [{status:'FAILED'},{status:'IN_PROGRESS',executionTime:21*60*1000}]){
    const result=await run({claim,workerJob});
    assert.equal(result.calls.filter(call=>call.url.includes('/run')).length,1);
  }
});
