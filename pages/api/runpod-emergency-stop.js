const ENDPOINT_ID='id81aby9nfth9h';
const KNOWN_JOB_ID='5d3ae97e-da66-4027-a0d4-aa1f19d90952-u1';

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const key=String(process.env.RUNPOD_API_KEY||process.env.Run_Pod_Key||process.env.Run_Pod_key||'').trim();
  if(!key)return res.status(503).json({error:'RunPod API key missing'});
  const auth={Authorization:`Bearer ${key}`};
  const out={endpointId:ENDPOINT_ID};
  try{
    const h=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/health`,{headers:auth});
    out.before={status:h.status,body:await h.json().catch(()=>null)};
  }catch(error){out.beforeError=String(error?.message||error)}
  try{
    const p=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/purge-queue`,{method:'POST',headers:auth});
    out.purge={status:p.status,body:await p.json().catch(()=>null)};
  }catch(error){out.purgeError=String(error?.message||error)}
  try{
    const c=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/cancel/${KNOWN_JOB_ID}`,{method:'POST',headers:auth});
    out.cancel={status:c.status,body:await c.json().catch(()=>null)};
  }catch(error){out.cancelError=String(error?.message||error)}
  try{
    const patch=await fetch(`https://rest.runpod.io/v1/endpoints/${ENDPOINT_ID}`,{
      method:'PATCH',headers:{...auth,'Content-Type':'application/json'},
      body:JSON.stringify({workersMin:0,workersMax:0,idleTimeout:5})
    });
    out.scaleZero={status:patch.status,body:await patch.json().catch(()=>null)};
  }catch(error){out.scaleZeroError=String(error?.message||error)}
  await new Promise(resolve=>setTimeout(resolve,2500));
  try{
    const h=await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/health`,{headers:auth});
    out.after={status:h.status,body:await h.json().catch(()=>null)};
  }catch(error){out.afterError=String(error?.message||error)}
  return res.status(200).json(out);
}
