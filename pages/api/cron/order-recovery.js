import crypto from 'crypto';
import {head,list,put} from '@vercel/blob';
import {runpod} from '../_runpod';

const TERMINAL_FAILURES=new Set(['FAILED','CANCELLED','TIMED_OUT']);
const ACTIVE=new Set(['IN_QUEUE','IN_PROGRESS']);
const MAX_RECOVERIES=2;
const STALE_MS=35*60*1000;
const COOLDOWN_MS=10*60*1000;

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

export function recoveryReason(job,latestProgress,now=Date.now()){
  const status=String(job?.status||'').toUpperCase();
  if(TERMINAL_FAILURES.has(status))return `terminal_${status.toLowerCase()}`;
  if(!ACTIVE.has(status))return '';
  const providerAge=status==='IN_QUEUE'?Number(job?.delayTime||0):Number(job?.executionTime||0);
  const silentAge=latestProgress?now-latestProgress:providerAge;
  return Math.max(providerAge,silentAge)>STALE_MS?`stuck_${status.toLowerCase()}`:'';
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

async function requeue(order,reason,headers,base,token){
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

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  const{key,base}=runpod();
  if(!token||!key||!base)return res.status(503).json({error:'Recovery configuration incomplete'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  const page=await list({prefix:'mcs/orders/',limit:100,token});
  const results=[];
  for(const blob of page.blobs.slice(0,25)){
    try{
      const order=await readJson(blob.pathname,token);
      if(!order?.mcsJobId||!order?.stripeSessionId||!order?.runpodJobId)continue;
      const attempts=Number(order.recoveryAttempts||0);
      if(attempts>=MAX_RECOVERIES){results.push({orderId:order.mcsJobId,action:'max_recoveries'});continue}
      const lastRecovery=new Date(order.lastRecoveryAt||0).getTime()||0;
      if(Date.now()-lastRecovery<COOLDOWN_MS)continue;
      const response=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers});
      const job=await response.json().catch(()=>({}));
      if(!response.ok){results.push({orderId:order.mcsJobId,action:'provider_unavailable'});continue}
      const latest=ACTIVE.has(String(job.status||'').toUpperCase())?await latestProgressAt(order.mcsJobId,token):0;
      const reason=recoveryReason(job,latest);
      if(!reason)continue;
      const recovered=await requeue(order,reason,headers,base,token);
      results.push({orderId:order.mcsJobId,action:'requeued',reason,newJobId:recovered.runpodJobId});
    }catch(error){
      console.error('Automatic order recovery failed',{pathname:blob.pathname,error:String(error?.message||error)});
      results.push({orderId:blob.pathname,action:'error'});
    }
  }
  return res.status(200).json({ok:true,checked:page.blobs.length,results});
}
