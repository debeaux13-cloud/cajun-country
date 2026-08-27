import crypto from'crypto';
import{head,put}from'@vercel/blob';
import{runpod}from'./_runpod';

const TARGET='69efa6be-ef6d-426d-ac04-7dd28fd6d3f2';
const ENDPOINT='id81aby9nfth9h';
const ACCESS='mcs-receipt-20260827-7f9d1e6c';
const TEMPLATE='2w5x8empgg';
const SOURCE_BLOB='ab19e7cd199b49cd5ec188380bfa6dbb44078470';
const SOURCE_COMMIT='e622ea40d77ecd2021e63ee79bc969e97fb7d234';
const BUNDLE_SHA='ffb9fa624ecfa3626b2c5d58428de710772f8082f20ce317aefe723f09dc5125';

async function readJson(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok)throw new Error('Private record read failed');
  return response.json();
}
async function readBuffer(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok)throw new Error('Private asset read failed');
  return{bytes:Buffer.from(await response.arrayBuffer()),contentType:response.headers.get('content-type')||'image/png'};
}
async function json(r){return r.json().catch(()=>({}))}
function templateBody(t,command){const b={containerDiskInGb:t.containerDiskInGb,containerRegistryAuthId:t.containerRegistryAuthId||undefined,dockerEntrypoint:['/bin/bash','-lc'],dockerStartCmd:[command],env:t.env||{},imageName:t.imageName,isPublic:Boolean(t.isPublic),name:t.name,ports:t.ports||[],readme:t.readme||'',volumeInGb:t.volumeInGb||0,volumeMountPath:t.volumeMountPath||'/workspace'};for(const k of Object.keys(b))if(b[k]===undefined)delete b[k];return b}

async function statusPayload(order,key,base){
  const headers={Authorization:`Bearer ${key}`};
  const[jobResponse,endpointResponse,workersResponse,healthResponse]=await Promise.all([
    fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers}),
    fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{headers}),
    fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers`,{headers}),
    fetch(`https://api.runpod.ai/v2/${ENDPOINT}/health`,{headers})
  ]);
  const[job,endpoint,workerPayload,health]=await Promise.all([json(jobResponse),json(endpointResponse),json(workersResponse),json(healthResponse)]);
  const workers=Array.isArray(workerPayload?.workers)?workerPayload.workers.map(w=>({id:w.id,status:w.status,desiredStatus:w.desiredStatus,gpu:w.gpu,uptimeSeconds:w.uptimeSeconds,version:w.version??w.endpointVersion??w.workerVersion??null,serverlessVersion:w.serverlessVersion??null,createdAt:w.createdAt??null,lastStartedAt:w.lastStartedAt??null,error:w.error??null,lastError:w.lastError??null,errorMessage:w.errorMessage??null,reason:w.reason??null,runtime:w.runtime??null,fields:Object.keys(w)})):[];
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
  const logWorker=String(req.query?.logs||'');
  if(req.method==='GET'&&/^[a-z0-9]{14}$/.test(logWorker)){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),4500);
    const response=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers/${logWorker}/logs?tail=300`,{headers:{Authorization:`Bearer ${key}`},signal:controller.signal});
    const reader=response.body?.getReader();
    const decoder=new TextDecoder();
    let output='';
    try{while(reader&&output.length<120000){const part=await reader.read();if(part.done)break;output+=decoder.decode(part.value,{stream:true})}}catch{}
    clearTimeout(timer);
    return res.status(response.ok?200:response.status).json({workerId:logWorker,http:response.status,logs:output.slice(-100000)});
  }
  if(req.method==='POST'){
    const action=String(req.body?.action||'');
    if(action==='fix_v20_startup'){
      const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
      const templateResponse=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE}`,{headers});
      const current=await json(templateResponse);
      if(!templateResponse.ok)return res.status(502).json({error:'Template lookup failed',http:templateResponse.status});
      const blobUrl=`https://api.github.com/repos/debeaux13-cloud/cajun-country/git/blobs/${SOURCE_BLOB}`;
      const py=`import base64,json,urllib.request;d=json.load(urllib.request.urlopen('${blobUrl}'));open('/tmp/mcs-v20.tgz','wb').write(base64.b64decode(d['content']))`;
      const command=`set -euo pipefail; rm -rf /opt/mcs-bundle; mkdir -p /opt/mcs-bundle; python -c "${py}"; echo '${BUNDLE_SHA}  /tmp/mcs-v20.tgz' | sha256sum -c -; tar -xzf /tmp/mcs-v20.tgz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle"; echo "MCS source commit: ${SOURCE_COMMIT}"; exec bash /opt/mcs-bundle/start.sh`;
      const patched=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE}`,{method:'PATCH',headers,body:JSON.stringify(templateBody(current,command))});
      const patchedPayload=await json(patched);
      if(!patched.ok)return res.status(502).json({error:'Template patch failed',http:patched.status,payload:patchedPayload});
      const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
      const downPayload=await json(down);
      return res.status(down.ok?200:502).json({ok:down.ok,phase:'short_startup_installed_workers_stopping',templateVersion:patchedPayload.version??null,endpointVersion:downPayload.version??null});
    }
    if(action==='activate_v20'){
      const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
      const workersResponse=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers`,{headers});
      const workerPayload=await json(workersResponse);
      const workers=Array.isArray(workerPayload?.workers)?workerPayload.workers:[];
      if(workers.length)return res.status(409).json({error:'Workers still stopping',workers:workers.map(w=>({id:w.id,status:w.status,desiredStatus:w.desiredStatus}))});
      const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});
      const payload=await json(up);
      return res.status(up.ok?200:502).json({ok:up.ok,phase:'v20_active',endpointVersion:payload.version??null,payload});
    }
    if(action==='retry_safety_input'){
      if(order.mode!=='test'||order.runpodJobId!=='94c140d9-8c1a-466d-b123-965802636aee-u1')return res.status(409).json({error:'Exact safety-blocked paid receipt no longer current'});
      const before=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers:{Authorization:`Bearer ${key}`}});
      const beforeJob=await json(before);
      const detail=String(beforeJob.error||'');
      if(beforeJob.status!=='FAILED'||!detail.includes('SAFETY.INPUT.MULTIMODAL'))return res.status(409).json({error:'Paid test is not at the exact Runway input-safety failure',status:beforeJob.status||'',detail});
      const match=detail.match(/Runway task ([0-9a-f-]{36})/i);
      if(!match)return res.status(409).json({error:'Failed provider task id missing'});
      const failedTask=match[1];
      let failedScene=0;
      for(let scene=7;scene<=18;scene++){
        try{const record=await readJson(`mcs/jobs/${TARGET}/provider-tasks/animation-scene-${scene}.json`,token);if(String(record.providerJobId||'')===failedTask){failedScene=scene;break}}catch{}
      }
      if(!failedScene)return res.status(409).json({error:'Failed provider task is not mapped to a paid scene',failedTask});
      const source=await readBuffer(`mcs/jobs/${TARGET}/scene-image-${failedScene}.bin`,token);
      const runwayKey=process.env.Runway||process.env.RUNWAY_API_KEY||'';
      if(!runwayKey)return res.status(503).json({error:'Runway key missing'});
      const runwayResponse=await fetch('https://api.dev.runwayml.com/v1/image_to_video',{method:'POST',headers:{Authorization:`Bearer ${runwayKey}`,'Content-Type':'application/json','X-Runway-Version':'2024-11-06'},body:JSON.stringify({model:'gen4_turbo',promptImage:`data:${source.contentType};base64,${source.bytes.toString('base64')}`,promptText:'Wholesome family-friendly warm stylized 3D CGI movie. The principal characters perform a simple friendly full-body action with natural movement, blinking, breathing, and comfortable personal space. Preserve exact identity, anatomy, clothing, colors, markings, setting, and props. No text, danger, injury, intimacy, or frightening imagery.',ratio:'1280:720',duration:10})});
      const runwayPayload=await json(runwayResponse);
      if(!runwayResponse.ok||!runwayPayload.id)return res.status(502).json({error:'Safety-neutral scene retry was not accepted',http:runwayResponse.status,payload:runwayPayload});
      const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
      await put(`mcs/jobs/${TARGET}/provider-tasks/animation-scene-${failedScene}.json`,JSON.stringify({version:1,sceneNumber:failedScene,phase:'animation',provider:'runway-gen4-turbo',providerJobId:String(runwayPayload.id),status:'provider_started',retryAttempt:1,priorProviderJobId:failedTask,updatedAt:new Date().toISOString()}),options);
      const started=await fetch(base+'/run',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({input:{jobId:TARGET,callbackBase:'https://main-character-studios.vercel.app',mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,stripeSessionId:order.stripeSessionId}})});
      const startedPayload=await json(started);
      if(!started.ok||!startedPayload.id)return res.status(502).json({error:'Paid continuation after safety-neutral scene was not accepted',payload:startedPayload,scene:failedScene,runwayTaskId:runwayPayload.id});
      order={...order,priorRunpodJobId:order.runpodJobId,runpodJobId:String(startedPayload.id),runpodStatus:String(startedPayload.status||'IN_QUEUE'),safetyNeutralScene:failedScene,safetyNeutralTaskId:String(runwayPayload.id),safetyNeutralRetryAt:new Date().toISOString()};
      const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
      await Promise.all([put(orderPath,JSON.stringify(order),options),put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options),order.stripeEventId?put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options):Promise.resolve()]);
      return res.status(200).json({ok:true,scene:failedScene,priorProviderTaskId:failedTask,runwayTaskId:runwayPayload.id,runpodJobId:order.runpodJobId,status:order.runpodStatus});
    }
    if(action==='retry_runway_credits'){
      if(order.mode!=='test'||order.runpodJobId!=='8eca2ae3-d951-41ce-9895-e123c30ad7dc-u1')return res.status(409).json({error:'Exact credit-blocked paid receipt no longer current'});
      const before=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers:{Authorization:`Bearer ${key}`}});
      const beforeJob=await json(before);
      if(beforeJob.status!=='FAILED'||!String(beforeJob.error||'').includes('enough credits'))return res.status(409).json({error:'Paid test is not at the exact Runway credit failure',status:beforeJob.status||'',detail:beforeJob.error||''});
      const started=await fetch(base+'/run',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({input:{jobId:TARGET,callbackBase:'https://main-character-studios.vercel.app',mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,stripeSessionId:order.stripeSessionId}})});
      const startedPayload=await json(started);
      if(!started.ok||!startedPayload.id)return res.status(502).json({error:'Credit-funded paid retry was not accepted',payload:startedPayload});
      order={...order,priorRunpodJobId:order.runpodJobId,runpodJobId:String(startedPayload.id),runpodStatus:String(startedPayload.status||'IN_QUEUE'),runwayCreditRetryAt:new Date().toISOString()};
      const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
      const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
      await Promise.all([put(orderPath,JSON.stringify(order),options),put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options),order.stripeEventId?put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options):Promise.resolve()]);
      return res.status(200).json({ok:true,priorRunpodJobId:order.priorRunpodJobId,runpodJobId:order.runpodJobId,status:order.runpodStatus});
    }
    if(action==='retry_failed_prompt'){
      if(order.mode!=='test'||order.runpodJobId!=='45449dc0-9c3b-4019-9d15-f7e31db9113d-u1')return res.status(409).json({error:'Exact failed paid test receipt no longer current'});
      const before=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers:{Authorization:`Bearer ${key}`}});
      const beforeJob=await json(before);
      if(beforeJob.status!=='FAILED'||!String(beforeJob.error||'').includes("Character master prompt exceeded"))return res.status(409).json({error:'Paid test is not at the exact prompt failure',status:beforeJob.status||'',detail:beforeJob.error||''});
      const started=await fetch(base+'/run',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({input:{jobId:TARGET,callbackBase:'https://main-character-studios.vercel.app',mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,stripeSessionId:order.stripeSessionId}})});
      const startedPayload=await json(started);
      if(!started.ok||!startedPayload.id)return res.status(502).json({error:'Prompt-safe paid retry was not accepted',payload:startedPayload});
      order={...order,priorRunpodJobId:order.runpodJobId,runpodJobId:String(startedPayload.id),runpodStatus:String(startedPayload.status||'IN_QUEUE'),promptSafeRetryAt:new Date().toISOString()};
      const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
      const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
      await Promise.all([put(orderPath,JSON.stringify(order),options),put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options),order.stripeEventId?put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options):Promise.resolve()]);
      return res.status(200).json({ok:true,priorRunpodJobId:order.priorRunpodJobId,runpodJobId:order.runpodJobId,status:order.runpodStatus});
    }
    if(action!=='requeue_paid_test')return res.status(400).json({error:'Unsupported action'});
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
