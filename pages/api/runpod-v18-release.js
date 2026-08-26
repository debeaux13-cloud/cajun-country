import crypto from'crypto';
import{runpod}from'./_runpod';

const EXPECTED_TOKEN_HASH='c49f22f837aec0f964b48437e06547668e833bc9ed465e88d73191b3b811ab86';
const TEMPLATE_ID='2w5x8empgg';
const ENDPOINT_ID='id81aby9nfth9h';
const BUNDLE_URL='https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/main/worker/mcs-v18-bundle.tar.gz';
const BUNDLE_SHA256='b61f9d72bd8767b164fcfb85bb7ca757ff324640b0a4f643a107b1be4f747784';
const REQUIRED_VERSION='2026-08-26-mcs-v18-ai-story-director-stylized-family-final';

function authorized(req){
  const supplied=String(req.headers['x-mcs-release-token']||req.query?.token||'').trim();
  const actual=crypto.createHash('sha256').update(supplied).digest();
  const expected=Buffer.from(EXPECTED_TOKEN_HASH,'hex');
  return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}

function templateBody(template,command){
  const body={
    containerDiskInGb:template.containerDiskInGb,
    containerRegistryAuthId:template.containerRegistryAuthId||undefined,
    dockerEntrypoint:['/bin/bash','-lc'],
    dockerStartCmd:[command],
    env:template.env||{},
    imageName:template.imageName,
    isPublic:Boolean(template.isPublic),
    name:template.name,
    ports:template.ports||[],
    readme:template.readme||'',
    volumeInGb:template.volumeInGb||0,
    volumeMountPath:template.volumeMountPath||'/workspace'
  };
  for(const key of Object.keys(body))if(body[key]===undefined)delete body[key];
  return body;
}

async function json(response){return response.json().catch(()=>({}))}

async function endpointState(key){
  const headers={Authorization:`Bearer ${key}`};
  const[endpointResponse,workersResponse]=await Promise.all([
    fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{headers}),
    fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers`,{headers})
  ]);
  const[endpoint,workersPayload]=await Promise.all([json(endpointResponse),json(workersResponse)]);
  if(!endpointResponse.ok)throw new Error(`Endpoint lookup failed (${endpointResponse.status})`);
  if(!workersResponse.ok)throw new Error(`Worker lookup failed (${workersResponse.status})`);
  const workers=(Array.isArray(workersPayload?.workers)?workersPayload.workers:[]).map(worker=>({
    id:String(worker?.id||''),status:String(worker?.status||''),desiredStatus:String(worker?.desiredStatus||''),version:worker?.version??worker?.slsVersion??null
  }));
  return{endpoint,workers};
}

async function checkedBundle(){
  const response=await fetch(BUNDLE_URL,{headers:{'User-Agent':'main-character-studios-v18-release'}});
  if(!response.ok)throw new Error(`Worker bundle download failed (${response.status})`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const actual=crypto.createHash('sha256').update(bytes).digest('hex');
  if(actual!==BUNDLE_SHA256)throw new Error('Worker bundle checksum mismatch');
  return bytes.toString('base64');
}

async function liveVersion(base,headers){
  const start=await fetch(base+'/run',{method:'POST',headers,body:JSON.stringify({input:{action:'version'}})});
  const accepted=await json(start);
  if(!start.ok)throw new Error(accepted?.error||accepted?.message||`Worker version check failed (${start.status})`);
  const id=String(accepted?.id||'');
  if(!id)throw new Error('Worker version check returned no job ID');
  for(let attempt=0;attempt<50;attempt++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const response=await fetch(`${base}/status/${encodeURIComponent(id)}`,{headers});
    const payload=await json(response);
    if(!response.ok)throw new Error(payload?.error||payload?.message||`Worker version status failed (${response.status})`);
    if(payload?.status==='COMPLETED')return payload;
    if(['FAILED','CANCELLED','TIMED_OUT'].includes(String(payload?.status||'')))return payload;
  }
  return{status:'TIMED_OUT',id};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'GET or POST only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const action=String((req.method==='GET'?req.query?.action:req.body?.action)||'status');
  if(!['status','hold','patch','activate','version'].includes(action))return res.status(400).json({error:'Unsupported action'});
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'RunPod configuration incomplete'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  try{
    const before=await endpointState(key);
    if(action==='status')return res.status(200).json({ok:true,phase:'status',bundleSha256:BUNDLE_SHA256,endpoint:{id:ENDPOINT_ID,workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax,version:before.endpoint.version??null},workers:before.workers});
    if(action==='hold'){
      const response=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
      const updated=await json(response);
      if(!response.ok)return res.status(response.status).json({error:'Worker hold failed'});
      return res.status(200).json({ok:true,phase:'held',workersMin:updated.workersMin??0,workersMax:updated.workersMax??0,workers:before.workers});
    }
    if(action==='patch'){
      if(before.workers.length||Number(before.endpoint.workersMin)!==0||Number(before.endpoint.workersMax)!==0)return res.status(409).json({error:'Endpoint must be fully paused with no workers before patch',endpoint:{workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax},workers:before.workers});
      const[bundle,templateResponse]=await Promise.all([checkedBundle(),fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers})]);
      const template=await json(templateResponse);
      if(!templateResponse.ok)return res.status(templateResponse.status).json({error:'Template lookup failed'});
      const command=`set -euo pipefail; mkdir -p /opt/mcs-bundle; python -c "import base64; open('/tmp/mcs-worker.tar.gz','wb').write(base64.b64decode('${bundle}'))"; echo '${BUNDLE_SHA256}  /tmp/mcs-worker.tar.gz' | sha256sum -c -; tar -xzf /tmp/mcs-worker.tar.gz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle:\${PYTHONPATH:-}"; echo "MCS bundle sha256: ${BUNDLE_SHA256}"; exec bash /opt/mcs-bundle/start.sh`;
      const response=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{method:'PATCH',headers,body:JSON.stringify(templateBody(template,command))});
      if(!response.ok)return res.status(response.status).json({error:'Template v18 patch failed'});
      return res.status(200).json({ok:true,phase:'patched_and_paused',templateId:TEMPLATE_ID,endpointId:ENDPOINT_ID,bundleSha256:BUNDLE_SHA256});
    }
    if(action==='activate'){
      if(before.workers.length||Number(before.endpoint.workersMin)!==0||Number(before.endpoint.workersMax)!==0)return res.status(409).json({error:'Endpoint must be paused with no old workers before activation',endpoint:{workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax},workers:before.workers});
      const response=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:1})});
      const updated=await json(response);
      if(!response.ok)return res.status(response.status).json({error:'Worker activation failed'});
      return res.status(200).json({ok:true,phase:'activated_at_one',workersMin:updated.workersMin??0,workersMax:updated.workersMax??1,endpointVersion:updated.version??null});
    }
    if(Number(before.endpoint.workersMax)!==1)return res.status(409).json({error:'Version check requires endpoint capped at one worker',workersMax:before.endpoint.workersMax});
    const versionPayload=await liveVersion(base,headers);
    const output=versionPayload?.output||{};
    if(versionPayload?.status!=='COMPLETED'||output.bundleVersion!==REQUIRED_VERSION)return res.status(409).json({error:'Live worker does not match the required V18 bundle',runpodStatus:versionPayload?.status||'',output});
    return res.status(200).json({ok:true,phase:'version',runpodStatus:versionPayload.status,output});
  }catch(error){
    return res.status(502).json({error:String(error?.message||error).slice(0,500)});
  }
}
