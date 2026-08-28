const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const ID='11111111-1111-4111-8111-111111111111';
test('ready PATCH persists completion time once and reopening does not move expiry',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','pages','api','internal','preview-pipeline','[id].js'),'utf8')
    .replace("import{head,put}from'@vercel/blob';","const {head,put}=blob;")
    .replace("import{subjectContract}from'../../../../lib/subject-contract';","const {subjectContract}=subject;")
    .replace("import{persistSavedPreview}from'../../../../lib/saved-previews';","const {persistSavedPreview}=saved;")
    .replace('export default async function handler','async function handler')+'\nmodule.exports=handler;';
  const T0='2026-08-28T12:00:00.000Z';const writes=[];const calls=[];
  class FixedDate extends Date{constructor(value){super(value===undefined?T0:value)}static now(){return Date.parse(T0)}}
  const context={module:{exports:{}},process:{env:{MCS_WORKER_SECRET:'secret',BLOB_READ_WRITE_TOKEN:'blob'}},Date:FixedDate,Number,JSON,Buffer,console:{log:()=>{}},blob:{put:async(pathname,value)=>writes.push({pathname,value:JSON.parse(value)}),head:async()=>({})},subject:{subjectContract:()=>({})},saved:{persistSavedPreview:async(...args)=>calls.push(args)}};
  vm.runInNewContext(source,context);
  const handler=context.module.exports;const res={statusCode:0,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};
  await handler({method:'PATCH',query:{id:ID},headers:{authorization:'Bearer secret'},body:{stage:'ready',status:'ready'}},res);
  assert.equal(res.statusCode,200);assert.equal(writes[0].value.updatedAt,T0);assert.deepEqual(calls,[[ID,'blob',T0]]);
  const record={completedAt:calls[0][2],expiresAt:new Date(Date.parse(calls[0][2])+24*60*60*1000).toISOString()};
  const reopened={...record};assert.equal(reopened.completedAt,T0);assert.equal(reopened.expiresAt,'2026-08-29T12:00:00.000Z');
});
