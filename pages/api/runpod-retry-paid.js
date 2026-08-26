import crypto from 'crypto';
import {head,put} from '@vercel/blob';
import {runpod} from './_runpod';

const EXPECTED_TOKEN_HASH='0eda0e91d98424759930cec589757ec3ea408aec7e51c7e99ac4a42031fc89b2';
const MCS_JOB_ID='82566803-902c-48c2-a95a-73dd3014356a';
const TERMINAL=new Set(['FAILED','CANCELLED','TIMED_OUT','COMPLETED']);

function authorized(req){
  const supplied=String(req.headers['x-mcs-admin-token']||req.query?.token||'');
  const actual=crypto.createHash('sha256').update(supplied).digest('hex');
  try{
    const left=Buffer.from(actual,'hex');
    const right=Buffer.from(EXPECTED_TOKEN_HASH,'hex');
    return left.length===right.length&&crypto.timingSafeEqual(left,right);
  }catch{return false}
}

async function privateJson(path,token){
  const meta=await head(path,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error('Private order record could not be read');
  return response.json();
}

async function validPreviewAssets(token){
  const paths=[
    `mcs/jobs/${MCS_JOB_ID}/reference.bin`,
    `mcs/jobs/${MCS_JOB_ID}/story-plan.bin`,
    ...Array.from({length:6},(_,index)=>`mcs/jobs/${MCS_JOB_ID}/scene-video-${index+1}.bin`)
  ];
  await Promise.all(paths.map(path=>head(path,{token})));
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});

  const blobToken=process.env.BLOB_READ_WRITE_TOKEN;
  const {key,base}=runpod();
  if(!blobToken||!key||!base)return res.status(503).json({error:'Paid retry configuration incomplete'});

  const orderPath=`mcs/orders/${MCS_JOB_ID}.json`;
  const lockPath=`mcs/admin-retries/${MCS_JOB_ID}-paid-v1.json`;
  const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token:blobToken,contentType:'application/json'};

  try{
    const order=await privateJson(orderPath,blobToken);
    if(order.mcsJobId!==MCS_JOB_ID||order.mode!=='test'||!String(order.stripeSessionId||'').startsWith('cs_test_')||!String(order.stripeEventId||'').startsWith('evt_')){
      return res.status(409).json({error:'Stored order is not the verified sandbox purchase'});
    }

    try{
      const delivered=await head(`mcs/jobs/${MCS_JOB_ID}/final-movie.bin`,{token:blobToken});
      if(delivered.contentType==='video/mp4'&&Number(delivered.size)>=500*1024){
        return res.status(409).json({error:'Order already has a deliverable movie'});
      }
    }catch{}

    const previousId=String(order.runpodJobId||'');
    const previousResponse=await fetch(`${base}/status/${encodeURIComponent(previousId)}`,{headers:{Authorization:`Bearer ${key}`}});
    const previous=await previousResponse.json();
    if(!previousResponse.ok)return res.status(502).json({error:'Previous paid run could not be verified'});
    const previousStatus=String(previous.status||'');
    const businessStatus=String(previous.output?.status||'');
    if(!TERMINAL.has(previousStatus)||businessStatus!=='manual_review'){
      return res.status(409).json({error:'Previous paid run is not eligible for this repair retry'});
    }

    await validPreviewAssets(blobToken);

    try{await head(lockPath,{token:blobToken});return res.status(409).json({error:'This repair retry was already used'})}
    catch{}
    await put(lockPath,JSON.stringify({mcsJobId:MCS_JOB_ID,previousRunpodJobId:previousId,createdAt:new Date().toISOString()}),{
      ...options,
      allowOverwrite:false
    });

    const callbackBase='https://main-character-studios.vercel.app';
    const response=await fetch(base+'/run',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
      body:JSON.stringify({input:{
        jobId:MCS_JOB_ID,
        callbackBase,
        mode:'paid',
        duration_seconds:180,
        preview_scene_count:6,
        total_scene_count:18,
        full_duration_seconds:180,
        stripeSessionId:String(order.stripeSessionId)
      }})
    });
    const result=await response.json();
    if(!response.ok)throw new Error('RunPod rejected the paid repair retry');

    const record={
      ...order,
      runpodJobId:String(result.id||''),
      runpodStatus:String(result.status||'IN_QUEUE'),
      previousRunpodJobId:previousId,
      retryReason:'paid-scene-validation-start-index',
      retriedAt:new Date().toISOString()
    };
    const sessionHash=crypto.createHash('sha256').update(String(order.stripeSessionId)).digest('hex');
    await Promise.all([
      put(orderPath,JSON.stringify(record),options),
      put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(record),options),
      put(`mcs/stripe-events/${String(order.stripeEventId)}.json`,JSON.stringify(record),options)
    ]);

    return res.status(200).json({
      ok:true,
      mcsJobId:MCS_JOB_ID,
      runpodJobId:record.runpodJobId,
      status:record.runpodStatus,
      reusedPreviewScenes:6,
      chargedAgain:false
    });
  }catch(error){
    console.error('One-time paid retry failed',error);
    return res.status(502).json({error:'Paid repair retry could not be started'});
  }
}
