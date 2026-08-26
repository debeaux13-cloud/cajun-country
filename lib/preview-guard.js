import crypto from 'crypto';
import{BlobNotFoundError,head,list,put}from'@vercel/blob';

const PREVIEW_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_PREFIX='mcs/preview-claims';
const RATE_PREFIX='mcs/preview-rate';

export function normalizePreviewRequestId(value){
  const id=String(value||'').trim();
  if(!PREVIEW_ID.test(id))throw new Error('A valid preview request is required');
  return id.toLowerCase();
}

export function previewRequestHash({creativeMode,originalIdea,storyBrief,sourceLedger,plan,image,moods}){
  const hash=crypto.createHash('sha256');
  for(const value of[
    creativeMode,
    originalIdea,
    JSON.stringify(storyBrief??null),
    JSON.stringify(sourceLedger??null),
    plan,
    image,
    JSON.stringify(Array.isArray(moods)?moods:[])
  ])hash.update(String(value??'')).update('\0');
  return hash.digest('hex');
}

function claimPath(id){return`${CLAIM_PREFIX}/${id}.json`}

async function privateJson(pathname,token){
  try{
    const meta=await head(pathname,{token});
    const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    if(!response.ok)throw new Error(`Preview request lookup failed (${response.status})`);
    return response.json();
  }catch(error){
    if(error instanceof BlobNotFoundError)return null;
    throw error;
  }
}

export async function getPreviewClaim(id,token){
  return privateJson(claimPath(normalizePreviewRequestId(id)),token);
}

async function writeClaim(id,claim,token,{overwrite}){
  await put(claimPath(id),JSON.stringify(claim),{
    access:'private',addRandomSuffix:false,allowOverwrite:overwrite,
    contentType:'application/json',cacheControlMaxAge:60,token
  });
  return claim;
}

export async function reservePreviewClaim({id,requestHash,mcsJobId,token}){
  const normalizedId=normalizePreviewRequestId(id);
  const existing=await privateJson(claimPath(normalizedId),token);
  if(existing)return classifyPreviewClaim(existing,requestHash);
  const claim={version:1,requestId:normalizedId,requestHash,mcsJobId,status:'submitting',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  try{
    await writeClaim(normalizedId,claim,token,{overwrite:false});
    return{state:'reserved',claim};
  }catch(error){
    const raced=await privateJson(claimPath(normalizedId),token);
    if(raced)return classifyPreviewClaim(raced,requestHash);
    throw error;
  }
}

export function classifyPreviewClaim(claim,requestHash){
  if(String(claim?.requestHash||'')!==requestHash)throw new Error('This preview button was already used for different story content. Reload the create page before making another preview.');
  if(claim?.status==='submitted'&&claim?.jobId&&claim?.mcsJobId)return{state:'submitted',claim};
  if(claim?.status==='submitting')return{state:'pending',claim};
  if(claim?.status==='submission_unknown')throw new Error('This preview may already be running, but its provider receipt was interrupted. Contact support with the preview request before trying again so no duplicate render is charged.');
  throw new Error('This preview request was already attempted and was not accepted. Please contact support before retrying so no duplicate render is charged.');
}

export async function updatePreviewClaim(id,claim,token,status,extra={}){
  const normalizedId=normalizePreviewRequestId(id);
  return writeClaim(normalizedId,{...claim,...extra,status,updatedAt:new Date().toISOString()},token,{overwrite:true});
}

function clientAddress(req){
  const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||String(req.socket?.remoteAddress||'unknown');
}

export function enforceOfficialPreviewOrigin(req){
  if(process.env.VERCEL_ENV!=='production')return;
  const origin=String(req.headers.origin||'').trim().toLowerCase();
  if(origin!=='https://main-character-studios.vercel.app')throw new Error('Preview requests must start on the official Main Character Studios create page.');
}

export async function enforcePreviewRateLimit(req,id,token,limit=3){
  const normalizedId=normalizePreviewRequestId(id);
  const day=new Date().toISOString().slice(0,10);
  const pepper=process.env.MCS_WORKER_SECRET||token;
  const fingerprint=crypto.createHash('sha256').update(pepper).update('\0').update(clientAddress(req)).digest('hex').slice(0,32);
  const prefix=`${RATE_PREFIX}/${day}/${fingerprint}/`;
  try{
    await put(`${prefix}${normalizedId}.json`,JSON.stringify({requestId:normalizedId,createdAt:new Date().toISOString()}),{
      access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json',cacheControlMaxAge:60,token
    });
  }catch(error){
    const same=await privateJson(`${prefix}${normalizedId}.json`,token);
    if(!same)throw error;
  }
  const found=await list({prefix,limit:limit+1,token});
  if(found.blobs.length>limit)throw new Error(`This connection has reached its ${limit}-preview daily safety limit. Try again tomorrow or contact support.`);
}

export function previewClaimResponse(claim){
  return{ok:true,mcsJobId:String(claim?.mcsJobId||''),jobId:String(claim?.jobId||''),status:String(claim?.runpodStatus||claim?.status||'')};
}
