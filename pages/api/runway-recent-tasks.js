import crypto from 'crypto';

const EXPECTED_TOKEN_HASH='65b4a4b768a74c813caac0d0272d22c643337df65c90ab8030965f37e40bd579';

function authorized(req){
  const supplied=String(req.headers['x-mcs-admin-token']||req.query?.token||'');
  const actual=crypto.createHash('sha256').update(supplied).digest('hex');
  try{
    const left=Buffer.from(actual,'hex');
    const right=Buffer.from(EXPECTED_TOKEN_HASH,'hex');
    return left.length===right.length&&crypto.timingSafeEqual(left,right);
  }catch{return false}
}

function promptText(task){
  return String(
    task?.promptText||
    task?.input?.promptText||
    task?.options?.promptText||
    task?.request?.promptText||
    ''
  ).slice(0,1200);
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const key=process.env.Runway||process.env.RUNWAY_API_KEY||'';
  if(!key)return res.status(503).json({error:'Runway key missing'});
  try{
    const response=await fetch('https://api.dev.runwayml.com/v1/tasks?limit=100',{
      headers:{Authorization:`Bearer ${key}`,'X-Runway-Version':'2024-11-06'}
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(response.status).json({ok:false,providerStatus:response.status,keys:Object.keys(payload||{}),message:String(payload?.error||payload?.message||'Task listing unavailable').slice(0,300)});
    const tasks=Array.isArray(payload)?payload:Array.isArray(payload?.tasks)?payload.tasks:Array.isArray(payload?.data)?payload.data:[];
    const recent=tasks.filter(task=>String(task?.createdAt||'')>='2026-08-26T19:18:30').map(task=>({
      id:String(task?.id||''),
      status:String(task?.status||''),
      createdAt:String(task?.createdAt||''),
      model:String(task?.model||task?.options?.model||task?.input?.model||''),
      promptText:promptText(task)
    }));
    return res.status(200).json({ok:true,count:recent.length,recent});
  }catch(error){return res.status(502).json({error:error.message})}
}

