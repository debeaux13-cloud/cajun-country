import{head}from'@vercel/blob';

async function readProgress(id,scene,token){
  const path=`mcs/jobs/${id}/progress-${scene}.json`;
  try{
    const meta=await head(path,{token});
    const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)return null;
    return await response.json();
  }catch{return null}
}

function scenePercent(item){
  if(!item)return 0;
  const stage=String(item.stage||'').toLowerCase();
  const status=String(item.status||'').toLowerCase();
  if(status==='animated')return 100;
  if(stage==='animating'&&['provider_started','motion_retry'].includes(status))return 68;
  if(stage==='sound'&&status==='ready')return 58;
  if(stage==='narrating'&&status==='narrated')return 48;
  if(stage==='illustrating'&&status==='illustrated')return 36;
  if(stage==='illustrating'&&status==='provider_started')return 12;
  if(status==='provider_failed'||status==='failed')return 0;
  return 6;
}

function messageFor(latest,complete,global){
  if(global?.stage==='ready'||global?.status==='ready')return'Your preview is ready.';
  if(String(global?.status||'').toLowerCase()==='failed')return String(global?.error||'Your preview stopped before it finished.').slice(0,300);
  if(global?.stage==='assembling')return'All six scenes are finished. Adding sound and assembling your movie…';
  if(complete>0)return`Scene ${complete} of 6 finished. The remaining scenes are still rendering…`;
  const stage=String(latest?.stage||'').toLowerCase();
  if(stage==='animating')return'Your characters are being animated now…';
  if(stage==='sound'||stage==='narrating')return'Adding voices and sound to your scenes…';
  if(stage==='illustrating')return'Creating your six movie scenes…';
  return'Your movie studio is working…';
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const id=String(req.query?.mcsJobId||'').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({error:'Valid preview ID required'});
  const token=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!token)return res.status(503).json({error:'Preview storage unavailable'});
  const values=await Promise.all([0,1,2,3,4,5,6].map(scene=>readProgress(id,scene,token)));
  const global=values[0];
  const scenes=values.slice(1);
  const active=scenes.filter(Boolean);
  const completedScenes=scenes.filter(item=>String(item?.status||'').toLowerCase()==='animated').length;
  const latest=[global,...active].filter(Boolean).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0]||null;
  let progress=Math.round(scenes.reduce((sum,item)=>sum+scenePercent(item),0)/6*.9);
  if(global?.stage==='assembling')progress=96;
  if(global?.stage==='ready'||global?.status==='ready')progress=100;
  return res.status(200).json({
    ok:true,
    progress,
    completedScenes,
    activeScenes:active.length,
    stage:latest?.stage||'starting',
    status:latest?.status||'working',
    message:messageFor(latest,completedScenes,global),
    updatedAt:latest?.updatedAt||null
  });
}