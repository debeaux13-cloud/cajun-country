import crypto from 'crypto';
import{runpod}from'./_runpod';

const EXPECTED_TOKEN_HASH='65b4a4b768a74c813caac0d0272d22c643337df65c90ab8030965f37e40bd579';
const ENDPOINT_ID='id81aby9nfth9h';
const PAID_JOB_ID='b391ed7e-7425-4fbc-adf0-351be2aad550-u2';
const MCS_JOB_ID='82566803-902c-48c2-a95a-73dd3014356a';

function authorized(req){
  const supplied=String(req.headers['x-mcs-admin-token']||'');
  const actual=crypto.createHash('sha256').update(supplied).digest('hex');
  try{
    const left=Buffer.from(actual,'hex');
    const right=Buffer.from(EXPECTED_TOKEN_HASH,'hex');
    return left.length===right.length&&crypto.timingSafeEqual(left,right);
  }catch{return false}
}

function redact(line){
  return String(line||'')
    .replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]')
    .replace(/\b(sk|key|secret|token)[-_][A-Za-z0-9_-]{12,}\b/gi,'[redacted]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,'[image-data]')
    .replace(/https?:\/\/[^\s"']+/gi,'[url]')
    .slice(0,500);
}

function parseSse(text){
  const entries=[];
  for(const frame of String(text||'').split(/\r?\n\r?\n/)){
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)continue;
    try{entries.push(JSON.parse(data))}catch{entries.push({raw:data})}
  }
  return entries;
}

async function logSnapshot(key,workerId){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4500);
  try{
    const response=await fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers/${encodeURIComponent(workerId)}/logs?tail=5000&source=container`,{
      headers:{Authorization:`Bearer ${key}`,Accept:'text/event-stream'},
      signal:controller.signal
    });
    if(!response.ok){
      const detail=await response.text().catch(()=>"");
      return{workerId,ok:false,status:response.status,detail:redact(detail)};
    }
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let body='';
    try{
      while(body.length<4_000_000){
        const{done,value}=await reader.read();
        if(done)break;
        body+=decoder.decode(value,{stream:true});
      }
    }catch(error){
      if(error?.name!=='AbortError')throw error;
    }
    const entries=parseSse(body);
    const known=new Set([MCS_JOB_ID,PAID_JOB_ID.replace(/-u\d+$/,'')]);
    const uuid=/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
    const matches=[];
    const providerIds=new Set();
    for(const entry of entries){
      const line=String(entry?.line||entry?.raw||'');
      const ids=[...line.matchAll(uuid)].map(match=>match[0].toLowerCase());
      const unknown=ids.filter(id=>!known.has(id));
      unknown.forEach(id=>providerIds.add(id));
      if(unknown.length||/runway|providerJobId|provider_started|illustrat|text_to_image|Scene\s+(7|8|9|10|11|12)\b/i.test(line)){
        matches.push({ts:String(entry?.ts||''),source:String(entry?.source||''),ids:unknown,context:redact(line)});
      }
    }
    return{workerId,ok:true,entryCount:entries.length,providerIds:[...providerIds],matches:matches.slice(-200)};
  }catch(error){
    if(error?.name==='AbortError')return{workerId,ok:true,entryCount:0,providerIds:[],matches:[],note:'snapshot timed out without a replay frame'};
    return{workerId,ok:false,error:redact(error.message)};
  }finally{clearTimeout(timer)}
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const{key,base}=runpod();
  if(!key)return res.status(503).json({error:'RunPod key missing'});
  try{
    const[workersResponse,statusResponse]=await Promise.all([
      fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT_ID}/workers`,{headers:{Authorization:`Bearer ${key}`}}),
      fetch(`${base}/status/${PAID_JOB_ID}`,{headers:{Authorization:`Bearer ${key}`}})
    ]);
    const workersPayload=await workersResponse.json().catch(()=>({}));
    const statusPayload=await statusResponse.json().catch(()=>({}));
    const workers=Array.isArray(workersPayload?.workers)?workersPayload.workers:[];
    const workerIds=new Set(workers.map(worker=>String(worker?.id||'')).filter(Boolean));
    for(const candidate of [statusPayload?.workerId,statusPayload?.worker_id,statusPayload?.worker?.id])if(candidate)workerIds.add(String(candidate));
    const snapshots=[];
    for(const workerId of workerIds)snapshots.push(await logSnapshot(key,workerId));
    return res.status(200).json({
      ok:true,
      workersStatus:workersResponse.status,
      jobStatus:statusResponse.status,
      job:{
        id:String(statusPayload?.id||PAID_JOB_ID),
        status:String(statusPayload?.status||''),
        workerId:String(statusPayload?.workerId||statusPayload?.worker_id||statusPayload?.worker?.id||''),
        delayTime:statusPayload?.delayTime??null,
        executionTime:statusPayload?.executionTime??null,
        retryCount:statusPayload?.retryCount??statusPayload?.retries??null
      },
      workers:workers.map(worker=>({id:String(worker?.id||''),status:String(worker?.status||''),version:worker?.version??worker?.endpointVersion??null,createdAt:worker?.createdAt||null,updatedAt:worker?.updatedAt||null})),
      snapshots
    });
  }catch(error){return res.status(502).json({error:redact(error.message)})}
}
