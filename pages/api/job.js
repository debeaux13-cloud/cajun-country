import{head}from'@vercel/blob';
import{runpod}from'./_runpod';
import{getPreviewClaimByMcsJobId}from'../../lib/preview-guard';
import{ensureSavedPreview}from'../../lib/saved-previews';

async function storedPreviewReady(mcsJobId,token){
  if(!mcsJobId||!token)return false;
  try{const movie=await head(`mcs/jobs/${mcsJobId}/preview-movie.bin`,{token});return movie.contentType==='video/mp4'&&Number(movie.size)>0}catch{return false}
}

export default async function handler(req,res){
  const requestedJobId=String(req.query?.jobId||'').trim();
  const mcsJobId=String(req.query?.mcsJobId||'').trim();
  if(!requestedJobId&&!mcsJobId)return res.status(400).json({error:'jobId or mcsJobId required'});
  const token=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(mcsJobId&&!token)return res.status(503).json({error:'Preview storage is unavailable'});
  let claim=null;
  if(mcsJobId){
    try{claim=await getPreviewClaimByMcsJobId(mcsJobId,token)}catch(error){return res.status(502).json({error:error.message})}
  }
  const storedPreview=await storedPreviewReady(mcsJobId,token);
  const effectiveJobId=String(claim?.jobId||requestedJobId).trim();
  if(storedPreview){await ensureSavedPreview(mcsJobId,token).catch(()=>null);return res.status(200).json({ok:true,status:'COMPLETED',providerStatus:String(claim?.status||'').toLowerCase()==='manual_review'?'MANUAL_REVIEW':String(claim?.runpodStatus||'NOT_FOUND'),storedPreviewReady:true,requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,videoUrl:'/api/preview-media?id='+encodeURIComponent(mcsJobId),output:{status:'ready'}});}
  if(String(claim?.status||'').toLowerCase()==='manual_review')return res.status(200).json({ok:true,status:'MANUAL_REVIEW',providerStatus:'MANUAL_REVIEW',requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,error:claim.failureMessage||'This preview needs manual review.',output:{status:'manual_review'}});
  if(!effectiveJobId)return res.status(404).json({error:'Preview job not found',requestedJobId,resolvedJobId:'',jobIdChanged:false});
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'Movie worker configuration incomplete'});
  try{
    const r=await fetch(base+'/status/'+encodeURIComponent(effectiveJobId),{headers:{Authorization:'Bearer '+key}});
    const j=await r.json();
    if(r.status===404)return res.status(200).json(storedPreview?{ok:true,status:'COMPLETED',providerStatus:'NOT_FOUND',storedPreviewReady:true,requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,videoUrl:'/api/preview-media?id='+encodeURIComponent(mcsJobId),output:{status:'ready'}}:{ok:true,status:'FAILED',providerStatus:'NOT_FOUND',requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,error:'This preview job is no longer available.',output:{status:'not_found'}});
    if(!r.ok)throw new Error(j?.error||j?.message||'Movie worker status failed');
    const o=j.output||{};
    const outputStatus=String(o.status||'').toLowerCase();
    const manualReview=outputStatus==='manual_review';
    const failedOutput=String(j.status||'').toUpperCase()==='COMPLETED'&&['failed','error'].includes(outputStatus);
    const customerStatus=manualReview?'MANUAL_REVIEW':failedOutput?'FAILED':j.status;
    console.log('[preview-status]',JSON.stringify({jobId:effectiveJobId,status:customerStatus,providerStatus:j.status,delayTime:j.delayTime??null,executionTime:j.executionTime??null,progress:o.progress??null,stage:o.stage||o.status_message||o.message||null}));
    res.status(200).json({ok:true,status:customerStatus,providerStatus:j.status,requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,progress:o.progress??null,stage:o.stage||o.status_message||o.message||null,delayTime:j.delayTime??null,executionTime:j.executionTime??null,videoUrl:o.video_url||o.videoUrl||o.url||null,error:(manualReview?(o.error||'This preview needs manual review.'):failedOutput?(o.error||'The movie worker could not finish this preview.'):j.error)||null,output:o});
  }catch(e){res.status(502).json({error:e.message,requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId})}
}
