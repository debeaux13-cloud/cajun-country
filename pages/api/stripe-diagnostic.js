import {head} from '@vercel/blob';

function classifyKey(key=''){
  if(key.startsWith('rk_test_'))return 'restricted_test';
  if(key.startsWith('rk_live_'))return 'restricted_live';
  if(key.startsWith('sk_test_'))return 'secret_test';
  if(key.startsWith('sk_live_'))return 'secret_live';
  return key?'other':'missing';
}

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});

  const key=String(process.env.STRIPE_SECRET_KEY||'');
  const result={
    vercelEnv:process.env.VERCEL_ENV||'unknown',
    salesEnabled:String(process.env.MCS_SALES_ENABLED||'').toLowerCase()==='true',
    stripeKeyConfigured:Boolean(key),
    stripeKeyClass:classifyKey(key),
    webhookEnvConfigured:Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    legacyWebhookEnvConfigured:Boolean(
      process.env.STRIPE_TEST_WEBHOOK_SECRET||
      process.env.Stripe_Webhook||
      process.env.StripeWebhook||
      process.env.stripeWebhook||
      process.env.STRIPE_WEBHOOK
    ),
    blobWebhookFallbackPresent:false,
    stripeReachable:false,
    stripeHttpStatus:null,
    stripeLivemode:null
  };

  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(token){
    try{
      await head('mcs/config/stripe-test-webhook-secret.json',{token});
      result.blobWebhookFallbackPresent=true;
    }catch{}
  }

  if(key){
    try{
      const response=await fetch('https://api.stripe.com/v1/balance',{
        headers:{Authorization:`Bearer ${key}`}
      });
      result.stripeHttpStatus=response.status;
      result.stripeReachable=response.ok;
      const body=await response.json().catch(()=>null);
      if(body&&typeof body.livemode==='boolean')result.stripeLivemode=body.livemode;
      if(!response.ok)result.stripeErrorType=body?.error?.type||'stripe_error';
    }catch(error){
      result.stripeNetworkError=String(error?.message||error).slice(0,160);
    }
  }

  return res.status(200).json(result);
}
