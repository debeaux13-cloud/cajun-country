import {head,issueSignedToken,presignUrl} from '@vercel/blob';

function stripeKey(){
  return process.env.Stripe||process.env.STRIPE_SECRET_KEY||'';
}

async function verifiedOrder(sessionId,key){
  const response=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,{
    headers:{Authorization:`Bearer ${key}`}
  });
  const session=await response.json();
  if(!response.ok||session.mode!=='payment'||session.status!=='complete'||session.payment_status!=='paid'||session.amount_total!==4900||session.currency!=='usd'||session.metadata?.product!=='mcs_3_minute_movie'){
    throw new Error('Order could not be verified');
  }
  const mcsJobId=String(session.metadata?.mcsJobId||'').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mcsJobId))throw new Error('Order is missing its movie reference');
  return mcsJobId;
}

async function matchingOrder(jobId,sessionId,token){
  const meta=await head(`mcs/orders/${jobId}.json`,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error('Order record could not be read');
  const order=await response.json();
  if(String(order.stripeSessionId||'')!==sessionId)throw new Error('Order does not match checkout');
}

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});

  const sessionId=String(req.query?.session_id||'').trim();
  const kind=String(req.query?.kind||'').trim();
  if(!/^cs_(?:test_)?[A-Za-z0-9_]{20,}$/.test(sessionId))return res.status(400).json({error:'A valid checkout session is required'});
  if(!['movie','storybook'].includes(kind))return res.status(400).json({error:'Media kind must be movie or storybook'});

  const key=stripeKey();
  if(!key||!process.env.BLOB_READ_WRITE_TOKEN)return res.status(503).json({error:'Order delivery is not configured'});

  try{
    const mcsJobId=await verifiedOrder(sessionId,key);
    await matchingOrder(mcsJobId,sessionId,process.env.BLOB_READ_WRITE_TOKEN);
    const filename=kind==='movie'?'final-movie.bin':'storybook-pdf.bin';
    const pathname=`mcs/jobs/${mcsJobId}/${filename}`;
    const media=await head(pathname,{token:process.env.BLOB_READ_WRITE_TOKEN});
    const validMovie=kind==='movie'&&media.contentType==='video/mp4'&&Number(media.size)>=500*1024;
    const validBook=kind==='storybook'&&media.contentType==='application/pdf'&&Number(media.size)>1024;
    if(!validMovie&&!validBook)throw new Error('Finished media failed delivery validation');
    const validUntil=Date.now()+60*60*1000;
    const token=await issueSignedToken({pathname,operations:['get'],validUntil});
    const {presignedUrl}=await presignUrl(token,{operation:'get',pathname,access:'private',validUntil});
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    return res.redirect(302,presignedUrl);
  }catch(error){
    return res.status(404).json({error:'Your finished file is not ready yet'});
  }
}
