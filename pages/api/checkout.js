import {head} from '@vercel/blob';
import {getSavedPreview,getSavedPreviewByShare} from '../../lib/saved-previews';

async function verifiedPreview(mcsJobId){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Preview verification is not configured');
  const preview=await getSavedPreview(mcsJobId,token);
  if(!preview)throw new Error('The free preview must be ready before checkout');
  const movie=await head(`mcs/jobs/${mcsJobId}/preview-movie.bin`,{token});
  if(movie.contentType!=='video/mp4'||Number(movie.size)<500*1024)throw new Error('The free preview media is incomplete');
  return preview;
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const key=process.env.Stripe||process.env.STRIPE_SECRET_KEY;
  if(!key)return res.status(503).json({error:'Stripe secret missing'});
  let mcsJobId=String(req.body?.mcsJobId||'').trim();
  const shareToken=String(req.body?.shareToken||'').trim();
  try{if(shareToken){const preview=await getSavedPreviewByShare(shareToken,process.env.BLOB_READ_WRITE_TOKEN||'');mcsJobId=String(preview?.mcsJobId||'');}await verifiedPreview(mcsJobId)}catch(error){return res.status(409).json({error:error.message})}
  const body=new URLSearchParams();
  body.set('mode','payment');
  body.set('success_url',`https://main-character-studios.vercel.app/my-orders?paid=1&order_id=${encodeURIComponent(mcsJobId)}&session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url','https://main-character-studios.vercel.app/create');
  body.set('line_items[0][price_data][currency]','usd');
  body.set('line_items[0][price_data][product_data][name]','Main Character Studios 3-minute personalized movie');
  body.set('line_items[0][price_data][unit_amount]','4900');
  body.set('line_items[0][quantity]','1');
  body.set('metadata[jobId]',mcsJobId);
  body.set('metadata[mcsJobId]',mcsJobId);
  body.set('metadata[product]','mcs_3_minute_movie');
  body.set('metadata[totalScenes]','18');
  body.set('metadata[previewScenes]','6');
  const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'},body});
  const j=await r.json();
  if(!r.ok)return res.status(r.status).json({error:j?.error?.message||'Stripe checkout failed'});
  res.status(200).json({ok:true,url:j.url,id:j.id});
}
