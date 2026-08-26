import crypto from 'crypto';
import{put}from'@vercel/blob';
import{runpod}from'./_runpod';
import{compileStoryScreenplay}from'./_story-screenplay';

export const config={api:{bodyParser:{sizeLimit:'15mb'}}};

async function store(id,kind,data,type){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Blob storage token missing');
  return put(`mcs/jobs/${id}/${kind}.bin`,data,{access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:type});
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'RunPod configuration incomplete'});
  const editedStory=String(req.body?.plan||'').trim();
  if(!editedStory||!req.body?.image)return res.status(400).json({error:'Story plan and photo are required'});
  const mcsJobId=crypto.randomUUID();
  const callbackBase='https://main-character-studios.vercel.app';
  try{
    const screenplay=await compileStoryScreenplay(editedStory,req.body?.moods||[]);
    const comma=req.body.image.indexOf(',');
    if(comma<0)throw new Error('Photo format is invalid');
    const meta=req.body.image.slice(0,comma);
    const image=Buffer.from(req.body.image.slice(comma+1),'base64');
    if(!image.length)throw new Error('Photo is empty');
    const imageType=(meta.match(/^data:([^;]+)/)||[])[1]||'image/jpeg';
    await store(mcsJobId,'reference',image,imageType);
    await store(mcsJobId,'story-plan',Buffer.from(JSON.stringify({plan:editedStory,screenplay})),'application/json');
    const r=await fetch(base+'/run',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({input:{
        jobId:mcsJobId,
        callbackBase,
        mode:'preview',
        workerSecret:process.env.MCS_WORKER_SECRET||'',
        duration_seconds:60,
        preview_scene_count:6,
        total_scene_count:18,
        full_duration_seconds:180
      }})
    });
    const j=await r.json();
    if(!r.ok)throw new Error(j?.error||j?.message||'RunPod rejected preview');
    return res.status(200).json({ok:true,mcsJobId,jobId:j.id,status:j.status});
  }catch(e){
    return res.status(502).json({error:e.message});
  }
}
