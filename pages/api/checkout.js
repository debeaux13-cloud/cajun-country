export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const key=process.env.Stripe||process.env.STRIPE_SECRET_KEY;
  if(!key)return res.status(503).json({error:'Stripe secret missing'});
  const body=new URLSearchParams();
  body.set('mode','payment');
  body.set('success_url','https://main-character-studios.vercel.app/my-orders?paid=1&session_id={CHECKOUT_SESSION_ID}');
  body.set('cancel_url','https://main-character-studios.vercel.app/create');
  body.set('line_items[0][price_data][currency]','usd');
  body.set('line_items[0][price_data][product_data][name]','Main Character Studios 3-minute personalized movie');
  body.set('line_items[0][price_data][unit_amount]','4900');
  body.set('line_items[0][quantity]','1');
  if(req.body?.jobId)body.set('metadata[jobId]',String(req.body.jobId));
  if(req.body?.mcsJobId)body.set('metadata[mcsJobId]',String(req.body.mcsJobId));
  body.set('metadata[product]','mcs_3_minute_movie');
  body.set('metadata[totalScenes]','18');
  body.set('metadata[previewScenes]','6');
  const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'},body});
  const j=await r.json();
  if(!r.ok)return res.status(r.status).json({error:j?.error?.message||'Stripe checkout failed'});
  res.status(200).json({ok:true,url:j.url,id:j.id});
}