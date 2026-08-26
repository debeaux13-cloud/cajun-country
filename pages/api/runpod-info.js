import { runpod } from './_runpod';

export default async function handler(req,res){
  const {key,base}=runpod();
  if(!key||!base)return res.status(503).json({ok:false,keyPresent:!!key,endpointPresent:!!base});
  try{
    const r=await fetch(base+'/health',{headers:{Authorization:'Bearer '+key}});
    const text=await r.text();
    let health=text;
    try{health=JSON.parse(text)}catch{}
    return res.status(r.ok?200:502).json({ok:r.ok,status:r.status,health});
  }catch(e){return res.status(502).json({ok:false,error:e.message});}
}
