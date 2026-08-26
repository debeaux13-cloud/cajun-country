function authorized(req){const s=process.env.MCS_WORKER_SECRET||'';const h=req.headers.authorization||'';return !!s&&(h==='Bearer '+s||h===s)}
function firstId(body,path){const candidates=[body?.jobId,body?.id,body?.orderId,body?.mcsJobId,body?.input?.jobId,body?.input?.id,body?.payload?.jobId,body?.job?.id,...(Array.isArray(path)?path:[])];return candidates.find(v=>typeof v==='string'&&(v.startsWith('probe-')||/^[0-9a-f-]{20,}$/i.test(v)))||null}
export default async function handler(req,res){
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  const path=req.query.path||[];const body=req.body||{};const id=firstId(body,path);
  if(!id)return res.status(400).json({error:'jobId required',matchedPath:path,bodyKeys:Object.keys(body),inputKeys:body?.input&&typeof body.input==='object'?Object.keys(body.input):[]});
  try{
    const r=await fetch('https://main-character-studios.vercel.app/api/internal/pipeline/jobs/'+encodeURIComponent(id),{headers:{Authorization:req.headers.authorization}});
    const text=await r.text();
    if(!r.ok)return res.status(r.status).send(text);
    const contract=JSON.parse(text);
    return res.status(200).json({...contract,claimed:true,bridgePath:path,claimedAt:new Date().toISOString()});
  }catch(e){return res.status(502).json({error:e.message,matchedPath:path});}
}
