import {put,head} from '@vercel/blob';
function auth(req){const s=process.env.MCS_WORKER_SECRET||'';const h=req.headers.authorization||'';return !!s&&(h==='Bearer '+s||h===s)}
function pathname(id,kind){return 'mcs/jobs/'+String(id)+'/'+String(kind||'preview')+'.bin'}
export default async function handler(req,res){
  if(!auth(req))return res.status(401).send('Unauthorized');
  const{id,kind='preview'}=req.query;const path=pathname(id,kind);const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  if(req.method==='PUT'||req.method==='POST'){
    const chunks=[];for await(const c of req)chunks.push(c);const data=Buffer.concat(chunks);
    const blob=await put(path,data,{access:'private',addRandomSuffix:false,token,contentType:req.headers['content-type']||'application/octet-stream'});
    return res.status(200).json({ok:true,id,kind,url:blob.url,downloadUrl:blob.downloadUrl||blob.url,size:data.length});
  }
  if(req.method==='GET'){
    try{const meta=await head(path,{token});const r=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)return res.status(r.status).json({error:'asset fetch failed'});res.setHeader('Content-Type',r.headers.get('content-type')||'application/octet-stream');res.setHeader('Cache-Control','private, no-store');return res.status(200).send(Buffer.from(await r.arrayBuffer()))}catch(e){return res.status(404).json({error:'asset not found'})}
  }
  return res.status(405).json({error:'Method not allowed'});
}
export const config={api:{bodyParser:false,responseLimit:false}};