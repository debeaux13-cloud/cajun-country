import{runpod}from'./_runpod';

export default async function handler(req,res){
  const{key}=runpod();
  const endpointId='id81aby9nfth9h';
  if(!key)return res.status(503).json({error:'RunPod key missing'});
  try{
    const response=await fetch(`https://rest.runpod.io/v1/endpoints/${endpointId}?includeWorkers=true`,{headers:{Authorization:'Bearer '+key}});
    const endpoint=await response.json();
    if(!response.ok)return res.status(response.status).json({error:'Endpoint lookup failed'});
    const workers=(endpoint.workers||[]).map(worker=>({
      id:worker.id||worker.workerId||null,
      status:worker.status||worker.desiredStatus||null,
      desiredStatus:worker.desiredStatus||null,
      version:worker.version??worker.endpointVersion??null,
      createdAt:worker.createdAt||null,
      startedAt:worker.startedAt||worker.lastStartedAt||null
    }));
    return res.status(200).json({
      id:endpoint.id,
      name:endpoint.name,
      version:endpoint.version,
      templateId:endpoint.templateId,
      workersMin:endpoint.workersMin,
      workersMax:endpoint.workersMax,
      workers
    });
  }catch(error){return res.status(502).json({error:error.message})}
}
