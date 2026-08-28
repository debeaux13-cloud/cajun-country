import{head,put}from'@vercel/blob';
function auth(req){const secret=process.env.MCS_WORKER_SECRET||'';const header=req.headers.authorization||'';return Boolean(secret)&&(header===`Bearer ${secret}`||header===secret)}
function assetPath(id,kind,scene){const suffix=scene?`-${String(scene)}`:'';return`mcs/jobs/${String(id)}/${String(kind||'preview')}${suffix}.bin`}
export default async function handler(req,res){
  if(!auth(req))return res.status(401).send('Unauthorized');
  const{id,kind='preview'}=req.query;const scene=String(req.query.scene||req.headers['x-mcs-scene']||'').trim();const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  const pathname=assetPath(id,kind,scene);
  if(req.method==='PUT'||req.method==='POST'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks);
    await put(pathname,data,{access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:req.headers['content-type']||'application/octet-stream'});
    console.log('[preview-artifact]',JSON.stringify({jobId:String(id),stage:'artifact-persistence',status:'stored',attempt:1,provider:'blob',duration:0,size:data.length}));
    return res.status(200).json({ok:true,jobId:String(id),kind:String(kind),scene:scene||null,size:data.length});
  }
  if(req.method==='GET'){
    try{const meta=await head(pathname,{token});const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)return res.status(response.status).json({error:'asset fetch failed'});res.setHeader('Content-Type',response.headers.get('content-type')||'application/octet-stream');res.setHeader('Cache-Control','private, no-store');return res.status(200).send(Buffer.from(await response.arrayBuffer()))}catch{return res.status(404).json({error:'asset not found'})}
  }
  return res.status(405).json({error:'Method not allowed'});
}
export const config={api:{bodyParser:false,responseLimit:false}};
