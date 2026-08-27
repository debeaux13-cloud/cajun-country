import crypto from 'crypto';
import {runpod} from './_runpod';

const TOKEN_HASH='1b65e5133e12724e7e605091a019abb3b809d6620bcf5abefed795982f3e8113';
const ENDPOINT_ID='id81aby9nfth9h';
const TEMPLATE_ID='2w5x8empgg';
const IMAGE='ghcr.io/debeaux13-cloud/cajun-country:mcs-worker-v23';

function authorized(req){
  const got=crypto.createHash('sha256').update(String(req.headers['x-mcs-release-token']||'')).digest('hex');
  return got===TOKEN_HASH;
}
async function json(response){return response.json().catch(()=>({}));}
async function verifyPublicImage(){
  const url='https://ghcr.io/v2/debeaux13-cloud/cajun-country/manifests/mcs-worker-v23';
  const accept='application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json';
  let response=await fetch(url,{headers:{Accept:accept}});
  if(response.status===401){
    const tokenResponse=await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository%3Adebeaux13-cloud%2Fcajun-country%3Apull');
    const tokenPayload=await json(tokenResponse);
    if(!tokenResponse.ok||!tokenPayload?.token)throw new Error(`Anonymous GHCR token failed (${tokenResponse.status})`);
    response=await fetch(url,{headers:{Accept:accept,Authorization:`Bearer ${tokenPayload.token}`}});
  }
  if(!response.ok)throw new Error(`Prebuilt image is not anonymously pullable (${response.status})`);
}
function body(template){
  const value={
    containerDiskInGb:template.containerDiskInGb,
    containerRegistryAuthId:null,
    dockerEntrypoint:[],
    dockerStartCmd:[],
    env:template.env||{},
    imageName:IMAGE,
    isPublic:false,
    name:template.name,
    ports:template.ports||[],
    readme:template.readme||'',
    volumeInGb:template.volumeInGb||0,
    volumeMountPath:template.volumeMountPath||'/workspace'
  };
  for(const key of Object.keys(value))if(value[key]===undefined)delete value[key];
  return value;
}
async function workers(headers){
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
      await verifyPublicImage();
      const response=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers});
      const template=await json(response);
      if(!response.ok)throw new Error(`Template lookup failed (${response.status})`);
      const patched=await fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}/update`,{method:'POST',headers,body:JSON.stringify(body(template))});
      if(!patched.ok)throw new Error(`Template update failed (${patched.status}): ${(await patched.text().catch(()=>'' )).slice(0,240)}`);
      const down=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
      if(!down.ok)throw new Error(`Endpoint scale-down failed (${down.status})`);
      console.info('Prebuilt MCS worker staged',{image:IMAGE});
      return res.status(200).json({ok:true,phase:'prebuilt_staged',image:IMAGE});
    }
    if(req.body?.action==='activate'){
      const current=await workers(headers);
      if(current.length)return res.status(409).json({error:'Workers still stopping',workers:current.map(worker=>({id:worker.id,status:worker.status}))});
      const up=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});
      if(!up.ok)throw new Error(`Endpoint activation failed (${up.status})`);
      console.info('Prebuilt MCS worker activated',{image:IMAGE});
      return res.status(200).json({ok:true,phase:'prebuilt_active',image:IMAGE});
    }
    if(req.body?.action==='status'){
      const[templateResponse,current]=await Promise.all([
        fetch(`https://rest.runpod.io/v1/templates/${TEMPLATE_ID}`,{headers}),
        workers(headers)
      ]);
      const template=await json(templateResponse);
      return res.status(200).json({ok:true,imageName:String(template.imageName||''),workers:current.map(worker=>({id:worker.id,status:worker.status}))});
    }
    return res.status(400).json({error:'Unsupported action'});
  }catch(error){
    console.error('Prebuilt worker release failed',error);
    return res.status(502).json({error:String(error?.message||error).slice(0,400)});
  }
}
