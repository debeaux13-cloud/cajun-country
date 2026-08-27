import crypto from'crypto';
import{head,put}from'@vercel/blob';
import{runpod}from'./_runpod';

const ACCESS='mcs-v22-release-20260827-3f55ad26';
const TARGET='69efa6be-ef6d-426d-ac04-7dd28fd6d3f2';
const CURRENT_JOB='9a9bf989-c81d-4dea-9a38-055e7ec9ed7b-u2';
const ENDPOINT='id81aby9nfth9h';
const TEMPLATE='2w5x8empgg';
const SOURCE_BLOB='44f0409455e66d0d8f9d359e5575ef957a1cd030';
const SOURCE_COMMIT='3f55ad260cb701294867ce95f904fd994305c39e';
const BUNDLE_SHA='06fcbc4b6cfbef3d18457de4e1503daba9358eaab69eeb095a69e82c578967cf';

async function json(r){return r.json().catch(()=>({}))}
async function readJson(path,token){const m=await head(path,{token});const r=await fetch(m.downloadUrl||m.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});if(!r.ok)throw new Error('Private record read failed');return r.json()}
function templateBody(t,command){const b={containerDiskInGb:t.containerDiskInGb,containerRegistryAuthId:t.containerRegistryAuthId||undefined,dockerEntrypoint:['/bin/bash','-lc'],dockerStartCmd:[command],env:t.env||{},imageName:t.imageName,isPublic:Boolean(t.isPublic),name:t.name,ports:t.ports||[],readme:t.readme||'',volumeInGb:t.volumeInGb||0,volumeMountPath:t.volumeMountPath||'/workspace'};for(const k of Object.keys(b))if(b[k]===undefined)delete b[k];return b}

export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='POST'||String(req.query?.key||'')!==ACCESS)return res.status(404).end();
 const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)return res.status(503).json({error:'Blob storage missing'});
 const{key,base}=runpod();if(!key||!base)return res.status(503).json({error:'RunPod configuration missing'});
 const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
 const orderPath=`mcs/orders/${TARGET}.json`;let order=await readJson(orderPath,token);
 if(order.runpodJobId!==CURRENT_JOB&&req.body?.action==='stage')return res.status(409).json({error:'Current paid job changed; stage blocked',current:order.runpodJobId});
 try{
  if(req.body?.action==='stage'){
   const statusResponse=await fetch(`${base}/status/${CURRENT_JOB}`,{headers});const status=await json(statusResponse);
   if(['IN_QUEUE','IN_PROGRESS'].includes(status.status)){const cancelled=await fetch(`${base}/cancel/${CURRENT_JOB}`,{method:'POST',headers});if(!cancelled.ok)throw new Error(`Current retry could not be stopped (${cancelled.status})`)}
   const[b,t]=await Promise.all([
    fetch(`https://api.github.com/repos/debeaux13-cloud/cajun-country/git/blobs/${SOURCE_BLOB}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'mcs-v22-release'}}),
    fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE}`,{headers})
   ]);
   const[bp,tp]=await Promise.all([json(b),json(t)]);if(!b.ok||bp.encoding!=='base64')throw new Error('V22 bundle lookup failed');if(!t.ok)throw new Error('Template lookup failed');
   const compact=String(bp.content||'').replace(/\s+/g,'');const bytes=Buffer.from(compact,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==BUNDLE_SHA)throw new Error('V22 checksum mismatch');
   const command=`set -euo pipefail; rm -rf /opt/mcs-bundle; mkdir -p /opt/mcs-bundle; python -c "import urllib.request;urllib.request.urlretrieve('https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/${SOURCE_COMMIT}/worker/mcs-v22-bundle.tar.gz','/tmp/mcs-v22.tgz')"; echo '${BUNDLE_SHA}  /tmp/mcs-v22.tgz' | sha256sum -c -; tar -xzf /tmp/mcs-v22.tgz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle"; echo "MCS source commit: ${SOURCE_COMMIT}"; exec bash /opt/mcs-bundle/start.sh`;
   const patch=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE}/update`,{method:'POST',headers,body:JSON.stringify(templateBody(tp,command))});if(!patch.ok){const detail=await patch.text().catch(()=>'');throw new Error(`Template update failed (${patch.status}): ${detail.slice(0,240)}`)};
   const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});if(!down.ok)throw new Error(`Endpoint scale-down failed (${down.status})`);
   return res.status(200).json({ok:true,phase:'v22_staged',priorJobStatus:status.status||'',sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
  }
  if(req.body?.action==='activate'){
   const workersResponse=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers`,{headers});const workersPayload=await json(workersResponse);const workers=Array.isArray(workersPayload?.workers)?workersPayload.workers:[];
   if(workers.length)return res.status(409).json({error:'Workers still stopping',workers:workers.map(w=>({id:w.id,status:w.status}))});
   const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});if(!up.ok)throw new Error(`Endpoint activation failed (${up.status})`);
   const started=await fetch(base+'/run',{method:'POST',headers,body:JSON.stringify({input:{jobId:TARGET,callbackBase:'https://main-character-studios.vercel.app',mode:'paid',duration_seconds:180,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180,stripeSessionId:order.stripeSessionId}})});const sp=await json(started);if(!started.ok||!sp.id)throw new Error('Paid continuation was not accepted');
   order={...order,priorRunpodJobId:order.runpodJobId,runpodJobId:String(sp.id),runpodStatus:String(sp.status||'IN_QUEUE'),autonomousV22At:new Date().toISOString(),workerSourceCommit:SOURCE_COMMIT};
   const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};const sessionHash=crypto.createHash('sha256').update(order.stripeSessionId).digest('hex');
   await Promise.all([put(orderPath,JSON.stringify(order),options),put(`mcs/checkout-sessions/${sessionHash}.json`,JSON.stringify(order),options),order.stripeEventId?put(`mcs/stripe-events/${order.stripeEventId}.json`,JSON.stringify(order),options):Promise.resolve()]);
   return res.status(200).json({ok:true,phase:'v22_active_paid_continuation_requeued',runpodJobId:order.runpodJobId,status:order.runpodStatus});
  }
  return res.status(400).json({error:'Unsupported action'});
 }catch(error){console.error('V22 release failed',error);return res.status(502).json({error:String(error?.message||error).slice(0,400)})}
}
