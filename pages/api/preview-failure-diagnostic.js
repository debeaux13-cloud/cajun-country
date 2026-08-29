import {head} from '@vercel/blob';

async function readJson(path, token){
  const meta=await head(path,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error(`read failed ${response.status}`);
  return response.json();
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const id=String(req.query?.id||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'valid id required'});
  const token=String(process.env.BLOB_READ_WRITE_TOKEN||'');
  if(!token)return res.status(503).json({error:'blob token missing'});
  const out={id};
  try{out.progress=await readJson(`mcs/jobs/${id}/progress-0.json`,token)}catch(error){out.progressError=String(error?.message||error)}
  try{out.orchestration=await readJson(`mcs/worker-orchestration/${id}.json`,token)}catch(error){out.orchestrationError=String(error?.message||error)}
  return res.status(200).json(out);
}
