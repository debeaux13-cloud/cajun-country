import{runpod}from'./_runpod';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export default async function handler(req,res){
 const{key}=runpod();const endpointId='id81aby9nfth9h';if(!key)return res.status(503).json({error:'RunPod key missing'});
 const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 try{
  const down=await fetch(`https://rest.runpod.io/v1/endpoints/${endpointId}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:0})});
  const downText=await down.text();if(!down.ok)return res.status(down.status).json({error:'scale-down failed',detail:downText.slice(0,500)});
  await sleep(2500);
  const up=await fetch(`https://rest.runpod.io/v1/endpoints/${endpointId}`,{method:'PATCH',headers,body:JSON.stringify({workersMin:0,workersMax:4})});
  const j=await up.json();if(!up.ok)return res.status(up.status).json({error:'scale-up failed',detail:j});
  return res.status(200).json({ok:true,id:j.id||endpointId,recycled:true,workersMax:j.workersMax??4,version:j.version??null});
 }catch(e){return res.status(502).json({error:e.message})}
}