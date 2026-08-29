import {getSavedPreview} from '../../lib/saved-previews';
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const token=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!token)return res.status(503).json({error:'Preview storage unavailable'});
  const ids=String(req.query?.ids||'').split(',').map(value=>value.trim()).filter(Boolean).slice(0,12);
  try{return res.status(200).json({previews:(await Promise.all(ids.map(id=>getSavedPreview(id,token)))).filter(Boolean)});}catch(error){return res.status(502).json({error:error.message});}
}
