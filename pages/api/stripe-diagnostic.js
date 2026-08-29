import {head} from '@vercel/blob';

function classifyKey(key=''){
  if(key.startsWith('rk_test_'))return 'restricted_test';
  if(key.startsWith('rk_live_'))return 'restricted_live';
  if(key.startsWith('sk_test_'))return 'secret_test';
  if(key.startsWith('sk_live_'))return 'secret_live';
  return key?'other':'missing';
}

async function stripeRequest(path,key,{method='GET',body}={}){
  const response=await fetch(`https://api.stripe.com${path}`,{
    method,
    headers:{
      Authorization:`Bearer ${key}`,
      ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})
    },
    body
  });
  const json=await response.json().catch(()=>null);
  return {response,json};
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
    stripeLivemode:null,
    checkoutCreateAttempted:false,
    checkoutCreated:false,
    checkoutLivemode:null,
    checkoutExpired:false
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
      const {response, json}=await stripeRequest('/v1/balance',key);
      result.stripeHttpStatus=response.status;
      result.stripeReachable=response.ok;
      if(json&&typeof json.livemode==='boolean')result.stripeLivemode=json.livemode;
      if(!response.ok)result.stripeErrorType=json?.error?.type||'stripe_error';
    }catch(error){
      result.stripeNetworkError=String(error?.message||error).slice(0,160);
    }
  }

  if(req.query.checkout==='1'&&key&&result.stripeKeyClass==='restricted_test'){
    result.checkoutCreateAttempted=true;
    const form=new URLSearchParams();
    form.set('mode','payment');
    form.set('success_url','https://example.com/success');
    form.set('cancel_url','https://example.com/cancel');
    form.set('line_items[0][price_data][currency]','usd');
    form.set('line_items[0][price_data][product_data][name]','MCS sandbox credential probe');
    form.set('line_items[0][price_data][unit_amount]','100');
    form.set('line_items[0][quantity]','1');
    form.set('metadata[purpose]','mcs_preview_key_probe');
    try{
      const created=await stripeRequest('/v1/checkout/sessions',key,{method:'POST',body:form});
      result.checkoutCreateHttpStatus=created.response.status;
      result.checkoutCreated=created.response.ok&&Boolean(created.json?.id);
      if(typeof created.json?.livemode==='boolean')result.checkoutLivemode=created.json.livemode;
      if(!created.response.ok){
        result.checkoutErrorType=created.json?.error?.type||'stripe_error';
        result.checkoutErrorCode=created.json?.error?.code||null;
        result.checkoutErrorMessage=String(created.json?.error?.message||'').slice(0,180);
      }
      if(result.checkoutCreated){
        const expired=await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(created.json.id)}/expire`,key,{method:'POST'});
        result.checkoutExpireHttpStatus=expired.response.status;
        result.checkoutExpired=expired.response.ok&&expired.json?.status==='expired';
      }
    }catch(error){
      result.checkoutNetworkError=String(error?.message||error).slice(0,160);
    }
  }

  return res.status(200).json(result);
}
