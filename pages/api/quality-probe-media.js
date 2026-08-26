import{issueSignedToken,presignUrl}from'@vercel/blob';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req,res){
  const id=String(req.query?.id||'').trim();
  if(!UUID.test(id))return res.status(400).json({error:'valid id required'});
  if(!process.env.BLOB_READ_WRITE_TOKEN)return res.status(503).json({error:'Preview storage unavailable'});
  const pathname=`mcs/jobs/${id}/identity-probe.bin`;
  try{
    const token=await issueSignedToken({pathname,operations:['get'],validUntil:Date.now()+60*60*1000});
    const{presignedUrl}=await presignUrl(token,{operation:'get',pathname,access:'private',validUntil:Date.now()+15*60*1000});
    res.setHeader('Cache-Control','private, no-store');
    return res.redirect(302,presignedUrl);
  }catch(error){
    return res.status(404).json({error:'Quality probe not ready',detail:error.message});
  }
}
