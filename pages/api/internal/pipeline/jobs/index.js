function authorized(req){const s=process.env.MCS_WORKER_SECRET||'';const h=req.headers.authorization||'';return !!s&&(h==='Bearer '+s||h===s)}

export default async function handler(req,res){
  if(!authorized(req))return res.status(401).json({error:'Unauthorized'});
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const body=req.body||{};
  const id=body.jobId||body.id||body.orderId||body.mcsJobId;
  if(!id)return res.status(400).json({error:'jobId required'});
  try{
    const r=await fetch('https://main-character-studios.vercel.app/api/internal/pipeline/jobs/'+encodeURIComponent(id),{headers:{Authorization:req.headers.authorization}});
    const text=await r.text();
    if(!r.ok)return res.status(r.status).send(text);
    const contract=JSON.parse(text);
    return res.status(200).json({...contract,claimed:true,claimedAt:new Date().toISOString()});
  }catch(e){return res.status(502).json({error:e.message});}
}
