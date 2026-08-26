import crypto from 'crypto';
import{runpod}from'./_runpod';

const EXPECTED_TOKEN_HASH='7c6694f352451253ea78437093b3c18d286a9e9e990d1b1fa5ea0afe7e9880e4';
const TEMPLATE_ID='2w5x8empgg';
const ENDPOINT_ID='id81aby9nfth9h';
const PAID_JOB_ID='b391ed7e-7425-4fbc-adf0-351be2aad550-u2';
const SOURCE_COMMIT='78463bb8ed210083b12dae24127359f465440380';
const SOURCE_BLOB_SHA='9fadbe17a38d2f85a1196a9058cae270c4c7162f';
const BUNDLE_SHA256='0a1e2e336e0a4897b10f0e64f6f23b873491aa1c93bf9f0208c6c32005c54e78';

function authorized(req){
  const supplied=String(req.headers['x-mcs-admin-token']||'');
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

async function json(response){
  return response.json().catch(()=>({}));
}

async function endpointState(key){
  const headers={Authorization:`Bearer ${key}`};
  const[endpointResponse,workersResponse,jobResponse]=await Promise.all([
    fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{headers}),
    fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers`,{headers}),
    fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${PAID_JOB_ID}`,{headers})
  ]);
  const[endpoint,workersPayload,job]=await Promise.all([
    json(endpointResponse),json(workersResponse),json(jobResponse)
  ]);
  if(!endpointResponse.ok)throw new Error(`Endpoint lookup failed (${endpointResponse.status})`);
  if(!workersResponse.ok)throw new Error(`Worker lookup failed (${workersResponse.status})`);
  const workers=Array.isArray(workersPayload?.workers)?workersPayload.workers:[];
  return{
    endpoint,
    workers:workers.map(worker=>({
      id:String(worker?.id||''),
      status:String(worker?.status||''),
      desiredStatus:String(worker?.desiredStatus||''),
      version:worker?.version??worker?.slsVersion??null
    })),
    job:jobResponse.ok?{
      id:String(job?.id||PAID_JOB_ID),
      status:String(job?.status||''),
      retryCount:job?.retryCount??job?.retries??null,
      delayTime:job?.delayTime??null,
      executionTime:job?.executionTime??null
    }:{id:PAID_JOB_ID,status:`lookup-${jobResponse.status}`}
  };
}

async function bundleBase64(){
  const response=await fetch(`https://api.github.com/repos/debeaux13-cloud/cajun-country/git/blobs/${SOURCE_BLOB_SHA}`,{
    headers:{Accept:'application/vnd.github+json','User-Agent':'main-character-studios-worker-patcher'}
  });
  const payload=await json(response);
  if(!response.ok||payload?.encoding!=='base64'||!payload?.content){
    throw new Error(`Immutable worker bundle lookup failed (${response.status})`);
  }
  const compact=String(payload.content).replace(/\s+/g,'');
  const bytes=Buffer.from(compact,'base64');
  const actual=crypto.createHash('sha256').update(bytes).digest('hex');
  if(actual!==BUNDLE_SHA256)throw new Error('Immutable worker bundle checksum mismatch');
  return bytes.toString('base64');
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const action=String(req.body?.action||'status');
  if(!['status','patch','up'].includes(action))return res.status(400).json({error:'Unsupported action'});
  const{key}=runpod();
  if(!key)return res.status(503).json({error:'RunPod key missing'});
  const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};

  try{
    const before=await endpointState(key);

    if(action==='status'){
      return res.status(200).json({
        ok:true,phase:'status',sourceCommit:SOURCE_COMMIT,bundleSha256:BUNDLE_SHA256,
        endpoint:{id:ENDPOINT_ID,workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax,version:before.endpoint.version??null},
        workers:before.workers,job:before.job
      });
    }

    if(action==='patch'){
      if(Number(before.endpoint.workersMin)!==0||Number(before.endpoint.workersMax)!==0||before.workers.length){
        return res.status(409).json({error:'Endpoint must remain fully paused before template patch',workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax,workers:before.workers});
      }
      const[bundle,templateResponse]=await Promise.all([
        bundleBase64(),
        fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers})
      ]);
      const template=await json(templateResponse);
      if(!templateResponse.ok)return res.status(templateResponse.status).json({error:'Template lookup failed'});
      const command=`set -euo pipefail; mkdir -p /opt/mcs-bundle; python -c "import base64; open('/tmp/mcs-worker.tar.gz','wb').write(base64.b64decode('${bundle}'))"; echo '${BUNDLE_SHA256}  /tmp/mcs-worker.tar.gz' | sha256sum -c -; tar -xzf /tmp/mcs-worker.tar.gz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle:\${PYTHONPATH:-}"; echo "MCS source commit: ${SOURCE_COMMIT}"; echo "MCS bundle sha256: ${BUNDLE_SHA256}"; exec bash /opt/mcs-bundle/start.sh`;
      const patch=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{
        method:'PATCH',headers,body:JSON.stringify(templateBody(template,command))
      });
      if(!patch.ok)return res.status(patch.status).json({error:'Template bundle patch failed'});
      const hold=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{
        method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})
      });
      if(!hold.ok)return res.status(hold.status).json({error:'Template patched but endpoint hold failed'});
      return res.status(200).json({ok:true,phase:'patched_and_paused',sourceCommit:SOURCE_COMMIT,bundleSha256:BUNDLE_SHA256,templateId:TEMPLATE_ID,endpointId:ENDPOINT_ID});
    }

    if(before.workers.length){
      return res.status(409).json({error:'Workers still exist; refusing overlapping paid execution',workers:before.workers});
    }
    if(Number(before.endpoint.workersMin)!==0||Number(before.endpoint.workersMax)!==0){
      return res.status(409).json({error:'Endpoint is not in the required paused state',workersMin:before.endpoint.workersMin,workersMax:before.endpoint.workersMax});
    }
    if(!['IN_PROGRESS','IN_QUEUE','QUEUED'].includes(before.job.status)){
      return res.status(409).json({error:'Paid job is not resumable',job:before.job});
    }
    const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{
      method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})
    });
    const updated=await json(up);
    if(!up.ok)return res.status(up.status).json({error:'Worker scale-up failed'});
    return res.status(200).json({ok:true,phase:'scaled_up_once',endpointVersion:updated.version??null,sourceCommit:SOURCE_COMMIT,bundleSha256:BUNDLE_SHA256,job:before.job});
  }catch(error){
    return res.status(502).json({error:String(error?.message||error).slice(0,300)});
  }
}
