import { runpod } from './_runpod';

export default async function handler(req,res){
  const {key,base}=runpod();
  const out={ok:false,keyPresent:!!key,endpointPresent:!!base,endpointReachable:false,status:null,error:null};
  if(!key||!base)return res.status(503).json(out);
  try{
    const r=await fetch(base+'/health',{headers:{Authorization:'Bearer '+key}});
    out.status=r.status;
    out.endpointReachable=r.ok;
    out.ok=r.ok;
    if(!r.ok){
      const t=await r.text();
      out.error=t.slice(0,180)||r.statusText;
    }
    return res.status(r.ok?200:502).json(out);
  }catch(e){
    out.error=e.message;
    return res.status(502).json(out);
  }
}
