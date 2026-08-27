import crypto from'crypto';
import{head,put}from'@vercel/blob';
import{runpod}from'./_runpod';

const TARGET='69efa6be-ef6d-426d-ac04-7dd28fd6d3f2';
const ENDPOINT='id81aby9nfth9h';
const ACCESS='mcs-receipt-20260827-7f9d1e6c';

async function readJson(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok)throw new Error('Private record read failed');
  return response.json();
}
async function json(r){return r.json().catch(()=>({}))}

async function statusPayload(order,key,base){
  const headers={Authorization:`Bearer ${key}`};
  const[jobResponse,endpointResponse,workersResponse,healthResponse]=await Promise.all([
    fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers}),
    fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{headers}),
    fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers`,{headers}),
    fetch(`https://api.runpod.ai/v2/${ENDPOINT}/health`,{headers})
  ]);
  const[job,endpoint,workerPayload,health]=await Promise.all([json(jobResponse),json(endpointResponse),json(workersResponse),json(healthResponse)]);
  const workers=Array.isArray(workerPayload?.workers)?workerPayload.workers.map(w=>({id:w.id,status:w.status,desiredStatus:w.desiredStatus,gpu:w.gpu,uptimeSeconds:w.uptimeSeconds})):[];
  return{mcsJobId:TARGET,mode:order.mode,stripeSessionId:order.stripeSessionId,runpodJobId:order.runpodJobId,runpodHttp:jobResponse.status,runpodStatus:String(job.status||''),delayTime:job.delayTime??null,executionTime:job.executionTime??null,output:job.output||null,error:job.error||null,endpoint:{http:endpointResponse.status,workersMin:endpoint.workersMin,workersMax:endpoint.workersMax,version:endpoint.version},health,workers};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(!['GET','POST'].includes(req.method)||String(req.query?.key||'')!==ACCESS)return res.status(404).end();
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  const orderPath=`mcs/orders/${TARGET}.json`;
  let order=await readJson(orderPath,token);
  const{key,base}=runpod();
  if(req.method==='POST'){
    if(String(req.body?.action||'')!=='requeue_paid_test')return res.status(400).json({error:'Unsupported action'});
    if(order.mode!=='test'||order.runpodJobId!=='dbf83f13-62f3-4288-846f-b3ee74490b68-u2')return res.status(409).json({error:'Exact queued test receipt no longer current'});
    const before=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers:{Authorization:`Bearer ${key}`}});
    const beforeJob=await json(before);
    if(beforeJob.status!=='IN_QUEUE')return res.status(409).json({error:'Paid test is no longer queued',status:beforeJob.status||''});
    const cancelled=await fetch(`${base}/cancel/${encodeURIComponent(order.runpodJobId)}`,{method:'POST',headers:{Authorization:`Bearer ${key}`}});
    const cancelledPayload=await json(cancelled);
    if(!cancelled.ok)return res.status(502).json({error:'Exact queued receipt could not be cancelled',payload:cancelledPayload});
    const started=await fetch(base+'/run',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({input:{jobId:TARGET,callbackBase:'https://main-character-studios.vercel.app',mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,stripeSessionId:order.stripeSessionId}})});
    const startedPayload=await json(started);
    if(!started.ok||!startedPayload.id)return res.status(502).json({error:'Replacement paid continuation was not accepted',cancelled:cancelledPayload,payload:startedPayload});
    order={...order,priorRunpodJobId:order.runpodJobId,runpodJobId:String(startedPayload.id),runpodStatus:String(startedPayload.status||'IN_QUEUE'),requeuedAt:new Date().toISOString()};
    const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
    const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
    await Promise.all([
      put(orderPath,JSON.stringify(order),options),
      put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options),
      order.stripeEventId?put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options):Promise.resolve()
    ]);
    return res.status(200).json({ok:true,cancelledJobId:order.priorRunpodJobId,runpodJobId:order.runpodJobId,status:order.runpodStatus});
  }
  return res.status(200).json(await statusPayload(order,key,base));
}
