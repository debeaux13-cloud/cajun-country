import{runpod}from'./_runpod';

export default async function handler(req,res){
  const{key,base}=runpod();
  const id=req.query?.jobId;
  if(!id)return res.status(400).json({error:'jobId required'});
  if(!key||!base)return res.status(503).json({error:'Movie worker configuration incomplete'});
  try{
    const r=await fetch(base+'/status/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+key}});
    const j=await r.json();
    if(!r.ok)throw new Error(j?.error||j?.message||'Movie worker status failed');
    const o=j.output||{};
    console.log('[preview-status]',JSON.stringify({jobId:id,status:j.status,delayTime:j.delayTime??null,executionTime:j.executionTime??null,progress:o.progress??null,stage:o.stage||o.status_message||o.message||null}));
    res.status(200).json({
      ok:true,
      status:j.status,
      progress:o.progress??null,
      stage:o.stage||o.status_message||o.message||null,
      delayTime:j.delayTime??null,
      executionTime:j.executionTime??null,
      videoUrl:o.video_url||o.videoUrl||o.url||null,
      error:j.error||null,
      output:o
    });
  }catch(e){res.status(502).json({error:e.message})}
}