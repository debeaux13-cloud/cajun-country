import crypto from 'crypto';
import {head,put} from '@vercel/blob';
import {runpod} from '../_runpod';

export const config={api:{bodyParser:false}};

const PAID_EVENTS=new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded'
]);

async function rawBody(req){
  const chunks=[];
  for await(const chunk of req)chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function webhookSecrets(){
  const secrets=[
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_TEST_WEBHOOK_SECRET,
    process.env.Stripe_Webhook,
    process.env.StripeWebhook,
    process.env.stripeWebhook,
    process.env.STRIPE_WEBHOOK
  ].filter(Boolean);
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(token){
    try{
      const meta=await head('mcs/config/stripe-test-webhook-secret.json',{token});
      const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
      if(response.ok){
        const stored=await response.json();
        if(stored?.secret)secrets.push(String(stored.secret));
      }
    }catch{}
  }
  return [...new Set(secrets)];
}

function verifySignature(payload,header,secrets){
  if(!header)return false;
  const parts=String(header).split(',').map(part=>part.trim().split('='));
  const timestamp=parts.find(([key])=>key==='t')?.[1];
  const signatures=parts.filter(([key])=>key==='v1').map(([,value])=>value);
  if(!timestamp||!signatures.length)return false;
  const age=Math.abs(Math.floor(Date.now()/1000)-Number(timestamp));
  if(!Number.isFinite(age)||age>300)return false;
  const signed=Buffer.concat([Buffer.from(String(timestamp)+'.'),payload]);
  return secrets.some(secret=>{
    const expected=crypto.createHmac('sha256',secret).update(signed).digest('hex');
    return signatures.some(signature=>{
      try{
        const a=Buffer.from(expected,'hex');
        const b=Buffer.from(signature,'hex');
        return a.length===b.length&&crypto.timingSafeEqual(a,b);
      }catch{return false}
    });
  });
}

async function blobExists(path,token){
  try{await head(path,{token});return true}catch{return false}
}

async function privateJson(path,token){
  const meta=await head(path,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error('Stored Stripe event could not be read');
  return response.json();
}

export default async function handler(req,res){
  const secrets=await webhookSecrets();
  if(req.method==='GET'){
    const configured=secrets.length>0;
    return res.status(configured?200:503).json({ok:configured,configured});
  }
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  if(!secrets.length)return res.status(503).json({error:'Stripe webhook secret missing'});

  const payload=await rawBody(req);
  if(!verifySignature(payload,req.headers['stripe-signature'],secrets)){
    return res.status(400).json({error:'Invalid Stripe signature'});
  }

  let event;
  try{event=JSON.parse(payload.toString('utf8'))}
  catch{return res.status(400).json({error:'Invalid JSON'})}

  if(!PAID_EVENTS.has(event.type))return res.status(200).json({received:true,ignored:true});

  const session=event?.data?.object||{};
  if(session.payment_status!=='paid'){
    return res.status(200).json({received:true,waitingForPayment:true});
  }

  const metadata=session.metadata||{};
  if(session.mode!=='payment'||session.amount_total!==4900||session.currency!=='usd'||metadata.product!=='mcs_3_minute_movie'){
    return res.status(200).json({received:true,ignored:true});
  }

  const mcsJobId=String(metadata.mcsJobId||'').trim();
  if(!mcsJobId)return res.status(400).json({error:'Missing mcsJobId metadata'});

  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});

  const stripeSessionId=String(session.id||'');
  const sessionHash=crypto.createHash('sha256').update(stripeSessionId).digest('hex');
  const eventPath=`mcs/stripe-events/${String(event.id)}.json`;
  const orderPath=`mcs/orders/${mcsJobId}.json`;
  const sessionPath=`mcs/checkout-sessions/${sessionHash}.json`;
  const options={access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'};
  if(await blobExists(eventPath,token)){
    try{
      const existing=await privateJson(eventPath,token);
      await put(sessionPath,JSON.stringify(existing),options);
    }catch{}
    return res.status(200).json({received:true,duplicate:true});
  }
  if(await blobExists(orderPath,token)){
    const existing=await privateJson(orderPath,token);
    await put(sessionPath,JSON.stringify(existing),options);
    await put(eventPath,JSON.stringify(existing),options);
    return res.status(200).json({received:true,duplicate:true});
  }

  const {key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'RunPod configuration incomplete'});

  try{
    const callbackBase='https://main-character-studios.vercel.app';
    const response=await fetch(base+'/run',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({input:{
        jobId:mcsJobId,
        callbackBase,
        mode:'paid',
        duration_seconds:180,
        preview_scene_count:6,
        total_scene_count:18,
        full_duration_seconds:180,
        stripeSessionId:String(session.id||'')
      }})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result?.error||result?.message||'RunPod rejected paid continuation');

    const record={
      stripeEventId:String(event.id),
      stripeSessionId,
      mcsJobId,
      runpodJobId:String(result.id||''),
      runpodStatus:String(result.status||'IN_QUEUE'),
      mode:event.livemode?'live':'test',
      createdAt:new Date().toISOString()
    };
    await put(orderPath,JSON.stringify(record),options);
    await put(sessionPath,JSON.stringify(record),options);
    await put(eventPath,JSON.stringify(record),options);
    return res.status(200).json({received:true,started:true});
  }catch(error){
    console.error('Stripe paid continuation failed',error);
    return res.status(500).json({error:'Paid movie could not be started; Stripe will retry'});
  }
}
