import{runpod}from'./_runpod';
import{getPreviewClaimByMcsJobId}from'../../lib/preview-guard';

export default async function handler(req,res){
  const requestedJobId=String(req.query?.jobId||'').trim();
  const mcsJobId=String(req.query?.mcsJobId||'').trim();
  if(!requestedJobId&&!mcsJobId)return res.status(400).json({error:'jobId or mcsJobId required'});
  let claim=null;
  if(mcsJobId){
    const token=process.env.BLOB_READ_WRITE_TOKEN||'';
    if(!token)return res.status(503).json({error:'Preview storage is unavailable'});
    try{claim=await getPreviewClaimByMcsJobId(mcsJobId,token)}catch(error){return res.status(502).json({error:error.message})}
    if(String(claim?.status||'').toLowerCase()==='manual_review'){
      return res.status(200).json({ok:true,status:'MANUAL_REVIEW',providerStatus:'MANUAL_REVIEW',requestedJobId,resolvedJobId:String(claim.jobId||requestedJobId),jobIdChanged:requestedJobId!==String(claim.jobId||requestedJobId),error:claim.failureMessage||'This preview needs manual review.',output:{status:'manual_review'}});
    }
  }
  const effectiveJobId=String(claim?.jobId||requestedJobId).trim();
  if(!effectiveJobId)return res.status(404).json({error:'Preview job not found',requestedJobId,resolvedJobId:'',jobIdChanged:false});
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'Movie worker configuration incomplete'});
  try{
    const r=await fetch(base+'/status/'+encodeURIComponent(effectiveJobId),{headers:{Authorization:'Bearer '+key}});
    const j=await r.json();
    if(r.status===404)return res.status(200).json({ok:true,status:'FAILED',providerStatus:'NOT_FOUND',requestedJobId,resolvedJobId:effectiveJobId,jobIdChanged:requestedJobId!==effectiveJobId,error:'This preview job is no longer available.',output:{status:'not_found'}});
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
