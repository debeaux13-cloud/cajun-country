import crypto from 'crypto';
import {runpod} from './_runpod';

const TOKEN_HASH='1b65e5133e12724e7e605091a019abb3b809d6620bcf5abefed795982f3e8113';
const ENDPOINT_ID='id81aby9nfth9h';
const TEMPLATE_ID='2w5x8empgg';
const SOURCE_COMMIT='ae1401b1546a00e8499172999dec5b90e0c94797';
const SOURCE_BLOB='13402cba1ff6992ca442978b7462c98241850b7f';
const BUNDLE_SHA='872cf9800b6037cfeebd705d9ab7b1882a7a3c7570fb0c613f97ad6a1020d46e';

function authorized(req){
  const got=crypto.createHash('sha256').update(String(req.headers['x-mcs-release-token']||'')).digest('hex');
  return got===TOKEN_HASH;
}
async function json(response){return response.json().catch(()=>({}));}
function templateBody(template,command){
  const body={
    containerDiskInGb:template.containerDiskInGb,
    containerRegistryAuthId:template.containerRegistryAuthId||undefined,
    dockerEntrypoint:['/bin/bash','-lc'],dockerStartCmd:[command],env:template.env||{},
    imageName:template.imageName,isPublic:Boolean(template.isPublic),name:template.name,
    ports:template.ports||[],readme:template.readme||'',volumeInGb:template.volumeInGb||0,
    volumeMountPath:template.volumeMountPath||'/workspace'
  };
  for(const key of Object.keys(body))if(body[key]===undefined)delete body[key];
  return body;
}
async function currentWorkers(headers){
  const response=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers`,{headers});
  const payload=await json(response);
  if(!response.ok)throw new Error(`Worker lookup failed (${response.status})`);
  return Array.isArray(payload?.workers)?payload.workers:[];
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const{key}=runpod();
  if(!key)return res.status(503).json({error:'RunPod configuration missing'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  try{
    if(req.body?.action==='stage'){
      const[bundleResponse,templateResponse]=await Promise.all([
        fetch(`https://api.github.com/repos/debeaux13-cloud/cajun-country/git/blobs/${SOURCE_BLOB}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'mcs-v23-release'}}),
        fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers})
      ]);
      const[bundle,template]=await Promise.all([json(bundleResponse),json(templateResponse)]);
      if(!bundleResponse.ok||bundle.encoding!=='base64')throw new Error('V23 bundle lookup failed');
      if(!templateResponse.ok)throw new Error(`Template lookup failed (${templateResponse.status})`);
      const bytes=Buffer.from(String(bundle.content||'').replace(/\s+/g,''),'base64');
      const actual=crypto.createHash('sha256').update(bytes).digest('hex');
      if(actual!==BUNDLE_SHA)throw new Error('V23 checksum mismatch');
      const command=`set -euo pipefail; rm -rf /opt/mcs-bundle; mkdir -p /opt/mcs-bundle; python -c "import urllib.request;urllib.request.urlretrieve('https://raw.githubusercontent.com/debeaux13-cloud/cajun-country/${SOURCE_COMMIT}/worker/mcs-v23-bundle.tar.gz','/tmp/mcs-v23.tgz')"; echo '${BUNDLE_SHA}  /tmp/mcs-v23.tgz' | sha256sum -c -; tar -xzf /tmp/mcs-v23.tgz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle"; echo "MCS source commit: ${SOURCE_COMMIT}"; exec bash /opt/mcs-bundle/start.sh`;
      const patched=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}/update`,{method:'POST',headers,body:JSON.stringify(templateBody(template,command))});
      if(!patched.ok)throw new Error(`Template update failed (${patched.status}): ${(await patched.text().catch(()=>'' )).slice(0,240)}`);
      const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
      if(!down.ok)throw new Error(`Endpoint scale-down failed (${down.status})`);
      console.info('V23 worker staged',{sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
      return res.status(200).json({ok:true,phase:'v23_staged',sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
    }
    if(req.body?.action==='activate'){
      const workers=await currentWorkers(headers);
      if(workers.length)return res.status(409).json({error:'Old workers still stopping',workers:workers.map(worker=>({id:worker.id,status:worker.status,desiredStatus:worker.desiredStatus}))});
      const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});
      if(!up.ok)throw new Error(`Endpoint activation failed (${up.status})`);
      console.info('V23 worker activated',{sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
      return res.status(200).json({ok:true,phase:'v23_active',sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
    }
    if(req.body?.action==='status'){
      const workers=await currentWorkers(headers);
      return res.status(200).json({ok:true,phase:'status',workers:workers.map(worker=>({id:worker.id,status:worker.status,desiredStatus:worker.desiredStatus}))});
    }
    return res.status(400).json({error:'Unsupported action'});
  }catch(error){
    console.error('V23 release failed',error);
    return res.status(502).json({error:String(error?.message||error).slice(0,400)});
  }
}
