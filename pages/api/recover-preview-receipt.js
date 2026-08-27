import{head}from'@vercel/blob';
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

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'||String(req.query?.key||'')!==ACCESS)return res.status(404).end();
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  const order=await readJson(`mcs/orders/${TARGET}.json`,token);
  const{key,base}=runpod();
  const headers={Authorization:`Bearer ${key}`};
  const[jobResponse,endpointResponse,workersResponse,healthResponse]=await Promise.all([
    fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{headers}),
    fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT}`,{headers}),
    fetch(`https://api.runpod.io/v2/serverless/${ENDPOINT}/workers`,{headers}),
    fetch(`https://api.runpod.ai/v2/${ENDPOINT}/health`,{headers})
  ]);
  const[job,endpoint,workerPayload,health]=await Promise.all([json(jobResponse),json(endpointResponse),json(workersResponse),json(healthResponse)]);
  const workers=Array.isArray(workerPayload?.workers)?workerPayload.workers.map(w=>({id:w.id,status:w.status,desiredStatus:w.desiredStatus,gpu:w.gpu,uptimeSeconds:w.uptimeSeconds})):[];
  return res.status(200).json({mcsJobId:TARGET,mode:order.mode,stripeSessionId:order.stripeSessionId,runpodJobId:order.runpodJobId,runpodHttp:jobResponse.status,runpodStatus:String(job.status||''),delayTime:job.delayTime??null,executionTime:job.executionTime??null,output:job.output||null,error:job.error||null,endpoint:{http:endpointResponse.status,workersMin:endpoint.workersMin,workersMax:endpoint.workersMax,version:endpoint.version},health,workers});
}
