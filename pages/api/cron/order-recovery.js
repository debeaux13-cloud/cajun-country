import crypto from 'crypto';
import {head,list,put} from '@vercel/blob';
import {runpod} from '../_runpod';
import {ORDER_RECOVERY_STALE_MS,orderRecoveryReason} from '../../../lib/order-recovery-reason';

const ACTIVE=new Set(['IN_QUEUE','IN_PROGRESS']);
const MAX_RECOVERIES=3;
const PREBUILT_MIGRATION_ORDER='82566803-902c-48c2-a95a-73dd3014356a';
const COOLDOWN_MS=10*60*1000;
const ELIGIBLE_AGE_MS=24*60*60*1000;
const PREVIEW_CLAIM_PREFIX='mcs/preview-claims/';
const PREVIEW_MAX_RECOVERIES=3;

function authorized(req){
  const secret=process.env.CRON_SECRET||'';
  const header=String(req.headers.authorization||'');
  if(secret)return header===`Bearer ${secret}`;
  return String(req.headers['user-agent']||'').toLowerCase().includes('vercel-cron');
}

async function readJson(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok)throw new Error(`Private record read failed (${response.status})`);
  return response.json();
}

async function latestProgressAt(jobId,token){
  const result=await list({prefix:`mcs/jobs/${jobId}/`,limit:1000,token});
  const relevant=result.blobs.filter(blob=>/\/(?:progress-|provider-tasks\/)/.test(blob.pathname));
  return relevant.reduce((latest,blob)=>Math.max(latest,new Date(blob.uploadedAt||0).getTime()||0),0);
}

async function saveOrder(order,token){
  const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
  const writes=[put(`mcs/orders/${order.mcsJobId}.json`,JSON.stringify(order),options)];
  if(order.stripeSessionId){
    const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
    writes.push(put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options));
  }
  if(order.stripeEventId)writes.push(put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options));
  await Promise.all(writes);
}

function stripeKey(){
  return process.env.Stripe||process.env.STRIPE_SECRET_KEY||'';
}

async function stripeSession(id,key){
  const response=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,{
    headers:{Authorization:`Bearer ${key}`}
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Stripe session lookup failed (${response.status})`);
  return payload;
}

async function refundPaidOrder(order){
  if(order.refundId)return{refundId:order.refundId,refundStatus:order.refundStatus||'succeeded'};
  const key=stripeKey();
  if(!key)throw new Error('Stripe secret missing for automatic refund');
  const session=await stripeSession(order.stripeSessionId,key);
  const paymentIntentId=String(order.stripePaymentIntentId||session.payment_intent||'');
  if(!paymentIntentId)throw new Error('Stripe payment intent missing for automatic refund');
  const body=new URLSearchParams();
  body.set('payment_intent',paymentIntentId);
  body.set('metadata[mcsJobId]',String(order.mcsJobId));
  body.set('metadata[reason]','render_recovery_exhausted');
  const response=await fetch('https://api.stripe.com/v1/refunds',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${key}`,
      'Content-Type':'application/x-www-form-urlencoded',
      'Idempotency-Key':`mcs-recovery-refund-${order.mcsJobId}`
    },
    body
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Stripe refund failed (${response.status}): ${String(payload?.error?.message||'unknown error').slice(0,180)}`);
  return{refundId:String(payload.id||''),refundStatus:String(payload.status||'pending'),stripePaymentIntentId:paymentIntentId};
}

async function exhaustPaidOrder(order,reason,token){
  let refund={};
  let refundError='';
  try{refund=await refundPaidOrder(order)}
  catch(error){refundError=String(error?.message||error)}
  const failed={
    ...order,
    ...refund,
    status:'failed',
    runpodStatus:'FAILED',
    customerState:refund.refundId?'refunded':'refund_pending',
    failureCode:'recovery_exhausted',
    failureReason:reason||order.lastRecoveryReason||'recovery_limit_reached',
    failureMessage:'The movie could not be completed after three automatic recovery attempts.',
    recoveryExhaustedAt:order.recoveryExhaustedAt||new Date().toISOString(),
    refundError:refundError||''
  };
  await saveOrder(failed,token);
  console.error('Automatic order recovery exhausted',{
    orderId:order.mcsJobId,
    attempts:Number(order.recoveryAttempts||0),
    refundStatus:failed.customerState,
    refundId:failed.refundId||'',
    refundError:failed.refundError
  });
  return failed;
}

async function exhaustPreview(pathname,claim,reason,token){
  const failed={
    ...claim,
    status:'failed',
    runpodStatus:'FAILED',
    failureCode:'recovery_exhausted',
    failureReason:reason||claim.lastRecoveryReason||'recovery_limit_reached',
    failureMessage:'The preview could not be completed after three automatic recovery attempts.',
    recoveryExhaustedAt:claim.recoveryExhaustedAt||new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  await savePreviewClaim(pathname,failed,token);
  console.error('Automatic preview recovery exhausted',{
    previewId:claim.mcsJobId,
    attempts:Number(claim.recoveryAttempts||0),
    reason:failed.failureReason
  });
  return failed;
}

async function ensurePaidContract(order){
  const secret=process.env.MCS_WORKER_SECRET||'';
  if(!secret)throw new Error('Paid contract preflight secret missing');
  const response=await fetch(`https://main-character-studios.vercel.app/api/internal/pipeline/jobs/${encodeURIComponent(order.mcsJobId)}`,{
    headers:{Authorization:`Bearer ${secret}`},
    cache:'no-store'
  });
  if(response.ok)return response.json();
  const payload=await response.json().catch(()=>({}));
  throw new Error(`Paid contract preflight failed (${response.status}): ${String(payload?.error||'unknown contract error').slice(0,240)}`);
}

async function requeue(order,reason,headers,base,token){
  await ensurePaidContract(order);
  const oldJobId=String(order.runpodJobId||'');
  if(reason.startsWith('stuck_')){
    const cancelled=await fetch(`${base}/cancel/${encodeURIComponent(oldJobId)}`,{method:'POST',headers});
    if(!cancelled.ok)throw new Error(`Stuck job cancel failed (${cancelled.status})`);
  }
  const started=await fetch(`${base}/run`,{
    method:'POST',headers,
    body:JSON.stringify({input:{
      jobId:order.mcsJobId,
      callbackBase:'https://main-character-studios.vercel.app',
      mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,
      stripeSessionId:order.stripeSessionId
    }})
  });
  const payload=await started.json().catch(()=>({}));
  if(!started.ok||!payload.id)throw new Error(`Recovery dispatch failed (${started.status})`);
  const recovered={...order,priorRunpodJobId:oldJobId,runpodJobId:String(payload.id),runpodStatus:String(payload.status||'IN_QUEUE'),recoveryAttempts:Number(order.recoveryAttempts||0)+1,lastRecoveryAt:new Date().toISOString(),lastRecoveryReason:reason};
  await saveOrder(recovered,token);
  return recovered;
}


async function savePreviewClaim(pathname,claim,token){
  await put(pathname,JSON.stringify(claim),{
    access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'
  });
}

async function previewMovieReady(mcsJobId,token){
  try{
    const movie=await head(`mcs/jobs/${mcsJobId}/preview-movie.bin`,{token});
    return movie.contentType==='video/mp4'&&Number(movie.size)>=500*1024;
  }catch{return false}
}

async function markPreviewManualReview(pathname,claim,reason,token){
  const updated={
    ...claim,
    status:'manual_review',
    failureCode:'manual_review',
    failureReason:reason||'worker_manual_review',
    failureMessage:'The preview needs manual review. It was not retried, cancelled, or re-rendered.',
    manualReviewAt:claim.manualReviewAt||new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  await savePreviewClaim(pathname,updated,token);
  console.info('Preview recovery skipped for manual review',{
    previewId:claim.mcsJobId,jobId:claim.jobId||'',reason:updated.failureReason
  });
  return updated;
}

async function requeuePreview(pathname,claim,reason,headers,base,token){
  const oldJobId=String(claim.jobId||'');
  if(reason.startsWith('stuck_')&&oldJobId){
    const cancelled=await fetch(`${base}/cancel/${encodeURIComponent(oldJobId)}`,{method:'POST',headers});
    if(!cancelled.ok)throw new Error(`Stuck preview cancel failed (${cancelled.status})`);
  }
  const started=await fetch(base+'/run',{
    method:'POST',headers,
    body:JSON.stringify({input:{
      jobId:claim.mcsJobId,
      callbackBase:'https://main-character-studios.vercel.app',
      mode:'preview',
      workerSecret:process.env.MCS_WORKER_SECRET||'',
      duration_seconds:60,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180
    }})
  });
  const payload=await started.json().catch(()=>({}));
  if(!started.ok||!payload.id)throw new Error(`Preview recovery dispatch failed (${started.status})`);
  const recovered={
    ...claim,priorJobId:oldJobId,jobId:String(payload.id),
    runpodStatus:String(payload.status||'IN_QUEUE'),status:'submitted',
    recoveryAttempts:Number(claim.recoveryAttempts||0)+1,
    lastRecoveryAt:new Date().toISOString(),lastRecoveryReason:reason,
    updatedAt:new Date().toISOString()
  };
  await savePreviewClaim(pathname,recovered,token);
  return recovered;
}

async function recoverPreviews(headers,base,token){
  const page=await list({prefix:PREVIEW_CLAIM_PREFIX,limit:100,token});
  const results=[];
  const recent=[...page.blobs]
    .sort((left,right)=>new Date(right.uploadedAt||0).getTime()-new Date(left.uploadedAt||0).getTime())
    .slice(0,25);
  for(const blob of recent){
    try{
      const claim=await readJson(blob.pathname,token);
      if(!claim?.mcsJobId)continue;
      if(String(claim.status||'').toLowerCase()==='manual_review'){
        results.push({previewId:claim.mcsJobId,action:'manual_review'});
        continue;
      }
      if(!['submitted','submitting','submission_unknown'].includes(String(claim.status||'')))continue;
      if(await previewMovieReady(claim.mcsJobId,token)){
        results.push({previewId:claim.mcsJobId,action:'ready'});
        continue;
      }
      const createdAt=new Date(claim.createdAt||0).getTime()||0;
      if(!createdAt||Date.now()-createdAt>ELIGIBLE_AGE_MS){
        results.push({previewId:claim.mcsJobId,action:'outside_recovery_window'});
        continue;
      }
      if(Number(claim.recoveryAttempts||0)>=PREVIEW_MAX_RECOVERIES){
        const failed=await exhaustPreview(blob.pathname,claim,claim.lastRecoveryReason,token);
        results.push({previewId:claim.mcsJobId,action:'failed',reason:failed.failureReason});
        continue;
      }
      const lastRecovery=new Date(claim.lastRecoveryAt||0).getTime()||0;
      if(Date.now()-lastRecovery<COOLDOWN_MS)continue;
      const latest=await latestProgressAt(claim.mcsJobId,token);
      let reason='';
      if(claim.status==='submitted'&&claim.jobId){
        const response=await fetch(`${base}/status/${encodeURIComponent(claim.jobId)}`,{headers});
        const job=await response.json().catch(()=>({}));
        if(!response.ok){
          reason=orderRecoveryReason(null,0,Date.now(),response.status);
          if(!reason){
            results.push({previewId:claim.mcsJobId,action:'provider_unavailable',providerHttp:response.status});
            continue;
          }
        }else if(String(job?.output?.status||'').toLowerCase()==='manual_review'){
          const updated=await markPreviewManualReview(blob.pathname,claim,'worker_manual_review',token);
          results.push({previewId:claim.mcsJobId,action:'manual_review',reason:updated.failureReason});
          continue;
        }else{
          reason=orderRecoveryReason(job,ACTIVE.has(String(job.status||'').toUpperCase())?latest:0);
        }
      }else{
        const updatedAt=new Date(claim.updatedAt||claim.createdAt||0).getTime()||0;
        const mostRecent=Math.max(updatedAt,latest);
        if(Date.now()-mostRecent>ORDER_RECOVERY_STALE_MS)reason=`stale_${String(claim.status)}`;
      }
      if(!reason)continue;
      const recovered=await requeuePreview(blob.pathname,claim,reason,headers,base,token);
      console.info('Automatic preview recovery requeued',{
        previewId:claim.mcsJobId,reason,priorRunpodJobId:claim.jobId||'',newRunpodJobId:recovered.jobId
      });
      results.push({previewId:claim.mcsJobId,action:'requeued',reason,newJobId:recovered.jobId});
    }catch(error){
      console.error('Automatic preview recovery failed',{pathname:blob.pathname,error:String(error?.message||error)});
      results.push({previewId:blob.pathname,action:'error'});
    }
  }
  return{checked:page.blobs.length,results};
}

async function runRecoveryCanary(headers,base){
  const response=await fetch(`${base}/health`,{headers});
  return {ok:response.ok,stage:'status_only',httpStatus:response.status};
}

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  const{key,base}=runpod();
  if(!token||!key||!base)return res.status(503).json({error:'Recovery configuration incomplete'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  const canary=await runRecoveryCanary(headers,base);
  const page=await list({prefix:'mcs/orders/',limit:100,token});
  const results=[];
  const recent=[...page.blobs]
    .sort((left,right)=>new Date(right.uploadedAt||0).getTime()-new Date(left.uploadedAt||0).getTime())
    .slice(0,25);
  for(const blob of recent){
    try{
      const order=await readJson(blob.pathname,token);
      if(!order?.mcsJobId||!order?.stripeSessionId||!order?.runpodJobId)continue;
      const createdAt=new Date(order.createdAt||0).getTime()||0;
      if(!createdAt||Date.now()-createdAt>ELIGIBLE_AGE_MS){results.push({orderId:order.mcsJobId,action:'outside_recovery_window'});continue}
      const attempts=Number(order.recoveryAttempts||0);
      const recoveryLimit=order.mcsJobId===PREBUILT_MIGRATION_ORDER?MAX_RECOVERIES+2:MAX_RECOVERIES;
      if(attempts>=recoveryLimit){
        const failed=await exhaustPaidOrder(order,order.lastRecoveryReason,token);
        results.push({orderId:order.mcsJobId,action:failed.refundId?'refunded':'refund_pending',refundId:failed.refundId||''});
        continue;
      }
      const lastRecovery=new Date(order.lastRecoveryAt||0).getTime()||0;
      if(Date.now()-lastRecovery<COOLDOWN_MS)continue;
      const response=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers});
      const job=await response.json().catch(()=>({}));
      if(!response.ok){
        const reason=orderRecoveryReason(null,0,Date.now(),response.status);
        if(!reason){results.push({orderId:order.mcsJobId,action:'provider_unavailable',providerHttp:response.status});continue}
        const recovered=await requeue(order,reason,headers,base,token);
        console.info('Automatic order recovery requeued',{
          orderId:order.mcsJobId,
          reason,
          priorRunpodJobId:order.runpodJobId,
          newRunpodJobId:recovered.runpodJobId
        });
        results.push({orderId:order.mcsJobId,action:'requeued',reason,newJobId:recovered.runpodJobId});
        continue;
      }
      const providerStatus=String(job.status||'').toUpperCase();
      const businessStatus=String(job?.output?.status||'').toLowerCase();
      if(providerStatus==='COMPLETED'&&businessStatus==='ready'){
        const completed={...order,status:'ready',runpodStatus:'COMPLETED',completedAt:order.completedAt||new Date().toISOString()};
        await saveOrder(completed,token);
        results.push({orderId:order.mcsJobId,action:'completed'});
        continue;
      }
      const latest=ACTIVE.has(providerStatus)?await latestProgressAt(order.mcsJobId,token):0;
      const reason=orderRecoveryReason(job,latest);
      if(!reason)continue;
      const recovered=await requeue(order,reason,headers,base,token);
      console.info('Automatic order recovery requeued',{
        orderId:order.mcsJobId,
        reason,
        priorRunpodJobId:order.runpodJobId,
        newRunpodJobId:recovered.runpodJobId
      });
      results.push({orderId:order.mcsJobId,action:'requeued',reason,newJobId:recovered.runpodJobId});
    }catch(error){
      console.error('Automatic order recovery failed',{pathname:blob.pathname,error:String(error?.message||error)});
      results.push({orderId:blob.pathname,action:'error'});
    }
  }
  const previews=await recoverPreviews(headers,base,token);
  return res.status(200).json({ok:true,canary,checked:page.blobs.length,results,previews});
}
