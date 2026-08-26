import {head} from '@vercel/blob';
import {runpod} from './_runpod';

async function verifiedPreview(jobId,mcsJobId){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  const{key,base}=runpod();
  if(!token||!key||!base)throw new Error('Preview verification is not configured');
  const response=await fetch(`${base}/status/${encodeURIComponent(jobId)}`,{headers:{Authorization:`Bearer ${key}`}});
  const job=await response.json();
  const output=job.output||{};
  if(!response.ok||job.status!=='COMPLETED'||output.status!=='ready'||!['preview','preview_sound_resume'].includes(output.mode)||Number(output.completed)!==6){
    throw new Error('The free preview must be ready before checkout');
  }
  const assets=await Promise.all([
    head(`mcs/jobs/${mcsJobId}/preview-movie.bin`,{token}),
    ...Array.from({length:6},(_,index)=>head(`mcs/jobs/${mcsJobId}/scene-video-${index+1}.bin`,{token}))
  ]);
  if(assets[0].contentType!=='video/mp4'||Number(assets[0].size)<500*1024||assets.slice(1).some(asset=>asset.contentType!=='video/mp4'||Number(asset.size)<100*1024)){
    throw new Error('The free preview media is incomplete');
  }
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const key=process.env.Stripe||process.env.STRIPE_SECRET_KEY;
  if(!key)return res.status(503).json({error:'Stripe secret missing'});
  const jobId=String(req.body?.jobId||'').trim();
  const mcsJobId=String(req.body?.mcsJobId||'').trim();
  if(!/^[A-Za-z0-9-]{20,100}$/.test(jobId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mcsJobId))return res.status(400).json({error:'A completed preview is required'});
  try{await verifiedPreview(jobId,mcsJobId)}catch(error){return res.status(409).json({error:error.message})}
  const body=new URLSearchParams();
  body.set('mode','payment');
  body.set('success_url',`https://main-character-studios.vercel.app/my-orders?paid=1&order_id=${encodeURIComponent(mcsJobId)}&session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url','https://main-character-studios.vercel.app/create');
  body.set('line_items[0][price_data][currency]','usd');
  body.set('line_items[0][price_data][product_data][name]','Main Character Studios 3-minute personalized movie');
  body.set('line_items[0][price_data][unit_amount]','4900');
  body.set('line_items[0][quantity]','1');
  body.set('metadata[jobId]',jobId);
  body.set('metadata[mcsJobId]',mcsJobId);
  body.set('metadata[product]','mcs_3_minute_movie');
  body.set('metadata[totalScenes]','18');
  body.set('metadata[previewScenes]','6');
  const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'},body});
  const j=await r.json();
  if(!r.ok)return res.status(r.status).json({error:j?.error?.message||'Stripe checkout failed'});
  res.status(200).json({ok:true,url:j.url,id:j.id});
}
