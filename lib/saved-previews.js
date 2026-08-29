import crypto from 'crypto';
import { BlobNotFoundError, head, put } from '@vercel/blob';
import { getPreviewClaimByMcsJobId } from './preview-guard';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY=24*60*60*1000;
const pathFor=id=>`mcs/saved-previews/${id}.json`;
const sharePath=token=>`mcs/saved-preview-shares/${token}.json`;
const moviePath=id=>`mcs/jobs/${id}/preview-movie.bin`;
const storybookPath=id=>`mcs/jobs/${id}/preview-storybook-pdf.bin`;

function validId(id){return ID.test(String(id||''));}
function active(record,now=Date.now()){return Boolean(record?.completedAt&&record?.expiresAt)&&now<=Date.parse(record.expiresAt);}
function publicRecord(record,now=Date.now()){
  if(!record||!active(record,now))return null;
  return {mcsJobId:record.mcsJobId,title:record.title,createdAt:record.createdAt,completedAt:record.completedAt,expiresAt:record.expiresAt,status:'ready',shareToken:record.shareToken,checkout:record.checkout||{mcsJobId:record.mcsJobId,purchaseStatus:'not_started'}};
}
async function privateJson(pathname,token){
  try{
    const meta=await head(pathname,{token});
    const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    if(!response.ok)throw new Error(`Saved preview read failed (${response.status})`);
    return response.json();
  }catch(error){if(error instanceof BlobNotFoundError||/not found/i.test(String(error?.message)))return null;throw error;}
}
async function titleFor(id,token){
  const plan=await privateJson(`mcs/jobs/${id}/story-plan.bin`,token);
  return String(plan?.screenplay?.title||plan?.title||'Your free movie preview').slice(0,180);
}
async function movieReady(id,token){
  try{const movie=await head(moviePath(id),{token});return movie.contentType==='video/mp4'&&Number(movie.size)>0;}catch{return false;}}
export async function persistSavedPreview(mcsJobId,token,completedAt){
  const id=String(mcsJobId||'').trim();
  if(!validId(id))throw new Error('Valid preview ID required');
  const existing=await privateJson(pathFor(id),token);
  if(existing)return existing;
  if(!await movieReady(id,token))throw new Error('Preview movie is not stored');
  const completedMs=Date.parse(completedAt);
  if(!Number.isFinite(completedMs))throw new Error('Valid preview completion time required');
  const claim=await getPreviewClaimByMcsJobId(id,token);
  const record={version:1,mcsJobId:id,title:await titleFor(id,token),createdAt:String(claim?.createdAt||completedAt),completedAt:new Date(completedMs).toISOString(),expiresAt:new Date(completedMs+DAY).toISOString(),status:'ready',previewMediaPathname:moviePath(id),shareToken:crypto.randomBytes(24).toString('base64url'),checkout:{mcsJobId:id,jobId:String(claim?.jobId||''),purchaseStatus:'not_started'}};
  await put(pathFor(id),JSON.stringify(record),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json',token});
  await put(sharePath(record.shareToken),JSON.stringify({mcsJobId:id}),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json',token});
  return record;
}
export async function ensureSavedPreview(mcsJobId,token,now=Date.now()){
  const id=String(mcsJobId||'').trim();
  if(!validId(id))throw new Error('Valid preview ID required');
  const existing=await privateJson(pathFor(id),token);
  if(existing)return existing;
  if(!await movieReady(id,token))return null;
  return persistSavedPreview(id,token,new Date(now).toISOString());
}
export async function getSavedPreview(mcsJobId,token,now=Date.now()){
  const record=await ensureSavedPreview(mcsJobId,token,now);
  return publicRecord(record,now);
}
export async function getSavedPreviewByShare(token,blobToken,now=Date.now()){
  const index=await privateJson(sharePath(String(token||'')),blobToken);
  if(!index?.mcsJobId)return null;
  return getSavedPreview(index.mcsJobId,blobToken,now);
}
export function sharedPreview(record,now=Date.now()){const preview=publicRecord(record,now);return preview&&{title:preview.title,createdAt:preview.createdAt,completedAt:preview.completedAt,expiresAt:preview.expiresAt,status:preview.status,shareToken:preview.shareToken};}
export async function storedMovieAvailable(record,token){return Boolean(record&&active(record)&&await movieReady(record.mcsJobId,token));}
export {DAY,active,moviePath,storybookPath,publicRecord};
