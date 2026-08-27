import crypto from'crypto';
import{runpod}from'./_runpod';
const TOKEN_HASH='aa6716b47f5d441c888daa2576c35798a8359255a11e4eb559c40cb49fcb1e8d';
const TEMPLATE_ID='2w5x8empgg';
const ENDPOINT_ID='id81aby9nfth9h';
const FAILED_JOB='5ff3f370-dbec-4a75-844f-c6fbdcb785a5-u1';
const SOURCE_COMMIT='354a044390413ff9e7f15f2e8ddef02f497d267a';
const SOURCE_BLOB='de3d29bd1cf4d290466a752229c59faa9f38bcfb';
const BUNDLE_SHA='aa71f8488f3ad89d08d98b1a779a7e2d43cc3ec7e43e07b7dd50e69edce28c0a';
function auth(req){const got=crypto.createHash('sha256').update(String(req.headers['x-mcs-release-token']||'')).digest('hex');return got===TOKEN_HASH}
async function json(r){return r.json().catch(()=>({}))}
function templateBody(t,command){const b={containerDiskInGb:t.containerDiskInGb,containerRegistryAuthId:t.containerRegistryAuthId||undefined,dockerEntrypoint:['/bin/bash','-lc'],dockerStartCmd:[command],env:t.env||{},imageName:t.imageName,isPublic:Boolean(t.isPublic),name:t.name,ports:t.ports||[],readme:t.readme||'',volumeInGb:t.volumeInGb||0,volumeMountPath:t.volumeMountPath||'/workspace'};for(const k of Object.keys(b))if(b[k]===undefined)delete b[k];return b}
async function state(key){const h={Authorization:`Bearer ${key}`};const[e,w,j]=await Promise.all([fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{headers:h}),fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers`,{headers:h}),fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${FAILED_JOB}`,{headers:h})]);const[ep,wp,jp]=await Promise.all([json(e),json(w),json(j)]);return{endpoint:ep,workers:Array.isArray(wp?.workers)?wp.workers:[],job:jp,http:{endpoint:e.status,workers:w.status,job:j.status}}}
export default async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');
 if(req.method!=='POST')return res.status(405).json({error:'POST only'});
 if(!auth(req))return res.status(401).json({error:'Unauthorized'});
 const{key}=runpod();if(!key)return res.status(503).json({error:'RunPod key missing'});
 const action=String(req.body?.action||'status');const headers={Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
 try{
  if(action==='status')return res.status(200).json({ok:true,...await state(key)});
  if(action==='cancel'){
   const r=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/cancel/${FAILED_JOB}`,{method:'POST',headers});const p=await json(r);return res.status(r.ok?200:r.status).json({ok:r.ok,action,payload:p});
  }
  if(action==='patch'){
   const[b,t]=await Promise.all([fetch(`https://api.github.com/repos/debeaux13-cloud/cajun-country/git/blobs/${SOURCE_BLOB}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'mcs-v19-release'}}),fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers})]);
   const[bp,tp]=await Promise.all([json(b),json(t)]);if(!b.ok||bp.encoding!=='base64')throw new Error('V19 bundle lookup failed');if(!t.ok)throw new Error('RunPod template lookup failed');
   const compact=String(bp.content||'').replace(/\s+/g,'');const bytes=Buffer.from(compact,'base64');const actual=crypto.createHash('sha256').update(bytes).digest('hex');if(actual!==BUNDLE_SHA)throw new Error('V19 checksum mismatch');
   const command=`set -euo pipefail; rm -rf /opt/mcs-bundle; mkdir -p /opt/mcs-bundle; python -c "import base64;open('/tmp/mcs-v19.tgz','wb').write(base64.b64decode('${compact}'))"; echo '${BUNDLE_SHA}  /tmp/mcs-v19.tgz' | sha256sum -c -; tar -xzf /tmp/mcs-v19.tgz -C /opt/mcs-bundle; export PYTHONPATH="/opt/mcs-bundle:\${PYTHONPATH:-}"; echo "MCS source commit: ${SOURCE_COMMIT}"; exec bash /opt/mcs-bundle/start.sh`;
   const patch=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{method:'PATCH',headers,body:JSON.stringify(templateBody(tp,command))});if(!patch.ok)throw new Error(`Template patch failed ${patch.status}`);
   const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});if(!down.ok)throw new Error(`Scale-down failed ${down.status}`);
   return res.status(200).json({ok:true,phase:'v19_patched_and_paused',sourceCommit:SOURCE_COMMIT,bundleSha:BUNDLE_SHA});
  }
  if(action==='up'){
   const s=await state(key);if(s.workers.length)return res.status(409).json({error:'Old worker still stopping',workers:s.workers.map(w=>({id:w.id,status:w.status,desiredStatus:w.desiredStatus}))});
   const r=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});const p=await json(r);return res.status(r.ok?200:r.status).json({ok:r.ok,phase:'v19_active',endpointVersion:p.version??null});
  }
  if(action==='probe'){
   const r=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/run`,{method:'POST',headers,body:JSON.stringify({input:{action:'version'}})});const p=await json(r);return res.status(r.ok?200:r.status).json({ok:r.ok,probeJobId:p.id||'',status:p.status||''});
  }
  return res.status(400).json({error:'Unsupported action'});
 }catch(error){return res.status(502).json({error:String(error?.message||error).slice(0,400)})}
}