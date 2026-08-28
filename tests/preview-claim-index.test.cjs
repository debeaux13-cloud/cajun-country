const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const MCS_ID='11111111-1111-4111-8111-111111111111';
class BlobNotFoundError extends Error {}
function loadGuard(records){
  const filename=path.join(__dirname,'..','lib','preview-guard.js');
  const source=fs.readFileSync(filename,'utf8')
    .replace("import crypto from 'crypto';","const crypto=require('crypto');")
    .replace("import{BlobNotFoundError,head,list,put}from'@vercel/blob';","const {BlobNotFoundError,head,list,put}=blob;")
    .replace(/export /g,'')+'\nmodule.exports={getPreviewClaimByMcsJobId,updatePreviewClaim};';
  const metrics={listCalls:0,claimReads:[],indexReads:0,writes:[]};
  const blob={BlobNotFoundError,
    head:async pathname=>{
      if(!Object.hasOwn(records,pathname))throw new BlobNotFoundError('missing');
      if(pathname.startsWith('mcs/preview-claim-index/'))metrics.indexReads++;
      else if(pathname.startsWith('mcs/preview-claims/'))metrics.claimReads.push(pathname);
      return{downloadUrl:'blob://'+pathname};
    },
    list:async({cursor})=>{
      metrics.listCalls++;
      return cursor?{blobs:[{pathname:'mcs/preview-claims/newest.json',uploadedAt:'2026-08-28T02:00:00.000Z'}]}:{blobs:[{pathname:'mcs/preview-claims/unrelated.json',uploadedAt:'2026-08-28T00:00:00.000Z'},{pathname:'mcs/preview-claims/older.json',uploadedAt:'2026-08-28T01:00:00.000Z'}],cursor:'page-2'};
    },
    put:async(pathname,value)=>{records[pathname]=JSON.parse(value);metrics.writes.push(pathname);}
  };
  const context={module:{exports:{}},require,crypto:require('crypto'),blob,BlobNotFoundError,Date,Set,String,JSON,Object,fetch:async url=>{const pathname=String(url).replace('blob://','');return{ok:true,json:async()=>records[pathname]};}};
  vm.runInNewContext(source,context,{filename});
  return{api:context.module.exports,metrics};
}

function legacyRecords(){return{
  'mcs/preview-claims/unrelated.json':{mcsJobId:'22222222-2222-4222-8222-222222222222',jobId:'OTHER'},
  'mcs/preview-claims/older.json':{requestId:'older',mcsJobId:MCS_ID,jobId:'OLD',updatedAt:'2026-08-28T01:00:00.000Z'},
  'mcs/preview-claims/newest.json':{requestId:'newest',mcsJobId:MCS_ID,jobId:'NEW',updatedAt:'2026-08-28T02:00:00.000Z'}
};}

test('legacy lookup scans once, selects newest claim, and backfills the direct index',async()=>{
  const records=legacyRecords(); const {api,metrics}=loadGuard(records);
  const claim=await api.getPreviewClaimByMcsJobId(MCS_ID,'token');
  assert.equal(claim.jobId,'NEW');
  assert.equal(metrics.listCalls,2);
  assert.deepEqual(records[`mcs/preview-claim-index/${MCS_ID}.json`],{requestId:'newest',mcsJobId:MCS_ID,pathname:'mcs/preview-claims/newest.json',updatedAt:'2026-08-28T02:00:00.000Z'});
  metrics.listCalls=0; metrics.claimReads=[];
  const indexed=await api.getPreviewClaimByMcsJobId(MCS_ID,'token');
  assert.equal(indexed.jobId,'NEW');
  assert.equal(metrics.listCalls,0);
  assert.deepEqual(metrics.claimReads,['mcs/preview-claims/newest.json']);
});

test('claim writes maintain the direct MCS job index',async()=>{
  const records={}; const {api}=loadGuard(records);
  await api.updatePreviewClaim('33333333-3333-4333-8333-333333333333',{mcsJobId:MCS_ID,status:'submitted'},'token','submitted',{jobId:'NEW'});
  assert.equal(records[`mcs/preview-claim-index/${MCS_ID}.json`].pathname,'mcs/preview-claims/33333333-3333-4333-8333-333333333333.json');
});
