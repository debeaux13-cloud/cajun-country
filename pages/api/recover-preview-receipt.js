import{head,list}from'@vercel/blob';
import{runpod}from'./_runpod';

const TARGET='69efa6be-ef6d-426d-ac04-7dd28fd6d3f2';
const ACCESS='mcs-receipt-20260827-7f9d1e6c';

async function readJson(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok)throw new Error('Claim read failed');
  return response.json();
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'||String(req.query?.key||'')!==ACCESS)return res.status(404).end();
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  let found=null,cursor;
  do{
    const page=await list({prefix:'mcs/preview-claims/',limit:1000,cursor,token});
    for(const blob of page.blobs){
      const claim=await readJson(blob.pathname,token);
      if(String(claim?.mcsJobId||'')===TARGET){found=claim;break}
    }
    cursor=page.cursor;
  }while(!found&&cursor);
  if(!found)return res.status(404).json({error:'Receipt not found'});
  const{key,base}=runpod();
  const response=await fetch(`${base}/status/${encodeURIComponent(found.jobId)}`,{headers:{Authorization:`Bearer ${key}`}});
  const job=await response.json();
  return res.status(200).json({mcsJobId:TARGET,jobId:String(found.jobId||''),claimStatus:String(found.status||''),runpodHttp:response.status,runpodStatus:String(job.status||''),output:job.output||null,error:job.error||null});
}
