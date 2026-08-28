const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const ID='11111111-1111-4111-8111-111111111111';
function load(records){
  const source=fs.readFileSync(path.join(__dirname,'..','lib','saved-previews.js'),'utf8')
    .replace("import crypto from 'crypto';","const crypto=require('crypto');")
    .replace("import { BlobNotFoundError, head, put } from '@vercel/blob';","const {BlobNotFoundError,head,put}=blob;")
    .replace("import { getPreviewClaimByMcsJobId } from './preview-guard';","const getPreviewClaimByMcsJobId=async()=>({createdAt:'2026-08-28T00:00:00.000Z',jobId:'provider-private'});")
    .replace(/export async function /g,'async function ').replace(/export function /g,'function ').replace(/export \{DAY,active,moviePath,publicRecord\};/, 'module.exports={DAY,active,moviePath,publicRecord,persistSavedPreview,ensureSavedPreview,getSavedPreview,getSavedPreviewByShare,storedMovieAvailable};');
  class BlobNotFoundError extends Error{}
  const blob={BlobNotFoundError,head:async pathname=>{if(pathname===`mcs/jobs/${ID}/preview-movie.bin`)return{contentType:'video/mp4',size:600000};if(!records[pathname])throw new BlobNotFoundError('missing');return{downloadUrl:'blob://'+pathname};},put:async(pathname,value)=>{records[pathname]=JSON.parse(value)}};
  const context={module:{exports:{}},require,crypto:require('crypto'),blob,BlobNotFoundError,Date,JSON,String,Number,Boolean,Math,fetch:async url=>({ok:true,json:async()=>records[String(url).replace('blob://','')]})};vm.runInNewContext(source,context);return context.module.exports;
}
test('ready-time persistence retains completion timestamps through reopening and expires only after expiresAt',async()=>{const records={};const api=load(records);const start=Date.parse('2026-08-28T00:00:00.000Z');const record=await api.persistSavedPreview(ID,'token',new Date(start).toISOString());const reopened=await api.ensureSavedPreview(ID,'token',start+6*60*60*1000);assert.equal(record.completedAt,'2026-08-28T00:00:00.000Z');assert.equal(record.expiresAt,'2026-08-29T00:00:00.000Z');assert.equal(reopened.completedAt,record.completedAt);assert.equal(reopened.expiresAt,record.expiresAt);assert.ok(api.publicRecord(record,Date.parse(record.expiresAt)));assert.equal(api.publicRecord(record,Date.parse(record.expiresAt)+1),null);});
test('share token resolves server record without exposing provider job IDs',async()=>{const records={};const api=load(records);const record=await api.ensureSavedPreview(ID,'token',0);const shared=await api.getSavedPreviewByShare(record.shareToken,'token',1);assert.equal(shared.mcsJobId,ID);assert.ok(record.shareToken.length>20);assert.notEqual(record.shareToken,ID);});
test('stored Blob movie remains authoritative independent of provider retention',async()=>{const records={};const api=load(records);const record=await api.ensureSavedPreview(ID,'token',Date.now());assert.equal(await api.storedMovieAvailable(record,'token'),true);});
