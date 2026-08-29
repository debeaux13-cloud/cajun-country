import crypto from 'crypto';
import {head} from '@vercel/blob';
import {runpod} from './_runpod';

function stripeKey(){
  return process.env.Stripe||process.env.STRIPE_SECRET_KEY||'';
}

async function stripeSession(id,key){
  const response=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,{
    headers:{Authorization:`Bearer ${key}`}
  });
  const session=await response.json();
  return response.ok?session:null;
}

function validUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));
}

function validPaidSession(session){
  return session?.mode==='payment'&&session?.status==='complete'&&session?.payment_status==='paid'&&session?.amount_total===4900&&session?.currency==='usd'&&session?.metadata?.product==='mcs_3_minute_movie';
}

async function privateJson(path,token){
  const meta=await head(path,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error('Order record could not be read');
  return response.json();
}

async function finalAssets(jobId,token){
  const[movie,storybook]=await Promise.all([
    head(`mcs/jobs/${jobId}/final-movie.bin`,{token}),
    head(`mcs/jobs/${jobId}/storybook-pdf.bin`,{token})
  ]);
  return{
    movie:movie.contentType==='video/mp4'&&Number(movie.size)>=500*1024,
    storybook:storybook.contentType==='application/pdf'&&Number(storybook.size)>1024
  };
}

function customerState(platformStatus,output){
  const businessStatus=String(output?.status||'').toLowerCase();
  if(platformStatus==='COMPLETED'&&businessStatus==='ready')return 'ready';
  if(platformStatus==='FAILED'||platformStatus==='CANCELLED'||platformStatus==='TIMED_OUT'||businessStatus==='manual_review')return 'needs_attention';
  if(platformStatus==='IN_PROGRESS')return 'rendering';
  return 'queued';
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');

  const sessionId=String(req.body?.sessionId||'').trim();
  const suppliedOrderId=String(req.body?.orderId||'').trim();
  if(!/^cs_(?:test_)?[A-Za-z0-9_]{20,}$/.test(sessionId)){
    return res.status(400).json({error:'A valid checkout session is required'});
  }

  const key=stripeKey();
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Order tracking is not configured'});

  try{
    let mcsJobId='';
    let order=null;
    if(key){
      const session=await stripeSession(sessionId,key);
      if(session){
        if(!validPaidSession(session))return res.status(403).json({error:'This checkout has not unlocked a movie'});
        mcsJobId=String(session.metadata?.mcsJobId||'').trim();
      }
    }

    if(!validUuid(mcsJobId)){
      const sessionHash=crypto.createHash('sha256').update(sessionId).digest('hex');
      try{
        const mapping=await privateJson(`mcs/checkout-sessions/${sessionHash}.json`,token);
        if(String(mapping.stripeSessionId||'')===sessionId&&validUuid(mapping.mcsJobId)){
          mcsJobId=String(mapping.mcsJobId);order=mapping;
        }
      }catch{}
    }

    if(!validUuid(mcsJobId)&&validUuid(suppliedOrderId)){
      try{
        const candidate=await privateJson(`mcs/orders/${suppliedOrderId}.json`,token);
        if(String(candidate.stripeSessionId||'')===sessionId){mcsJobId=suppliedOrderId;order=candidate}
      }catch{}
    }

    if(!validUuid(mcsJobId))return res.status(202).json({ok:true,state:'starting',message:'Payment received. Your movie is starting.'});
    if(!order){
      try{order=await privateJson(`mcs/orders/${mcsJobId}.json`,token)}
      catch{return res.status(202).json({ok:true,state:'starting',message:'Payment received. Your movie is starting.'})}
    }

    if(String(order.stripeSessionId||'')!==sessionId){
      return res.status(409).json({error:'This checkout does not match the saved order'});
    }
    let durableAssets={movie:false,storybook:false};
    try{durableAssets=await finalAssets(mcsJobId,token)}catch{}
    if(durableAssets.movie&&durableAssets.storybook)return res.status(200).json({ok:true,state:'ready',completedScenes:18,progress:null,message:'Your complete movie is ready.',movieUrl:`/api/order-media?session_id=${encodeURIComponent(sessionId)}&order_id=${encodeURIComponent(mcsJobId)}&kind=movie`,storybookUrl:`/api/order-media?session_id=${encodeURIComponent(sessionId)}&order_id=${encodeURIComponent(mcsJobId)}&kind=storybook`});

    if(String(order.status||'').toLowerCase()==='failed'){
      const refunded=String(order.customerState||'')==='refunded'||Boolean(order.refundId);
      return res.status(200).json({
        ok:true,
        state:'needs_attention',
        completedScenes:null,
        progress:null,
        message:refunded
          ?'We could not complete this movie, and your payment was automatically refunded.'
          :'We could not complete this movie. Your payment needs studio review before a refund can be completed.',
        movieUrl:null,
        storybookUrl:null,
        refunded,
        refundStatus:String(order.refundStatus||'')||null
      });
    }

    if(!String(order.runpodJobId||'').trim())return res.status(200).json({ok:true,state:'queued',completedScenes:null,progress:null,message:'Your movie is continuing from the preview you approved.',movieUrl:null,storybookUrl:null});
    const {key:runpodKey,base}=runpod();
    if(!runpodKey||!base)return res.status(503).json({error:'Movie rendering is not configured'});
    const response=await fetch(`${base}/status/${encodeURIComponent(order.runpodJobId)}`,{
      headers:{Authorization:`Bearer ${runpodKey}`}
    });
    const job=await response.json().catch(()=>({}));
    if(!response.ok){
      console.warn('Order render status is temporarily unavailable',{
        mcsJobId,
        runpodJobId:String(order.runpodJobId),
        providerHttp:response.status
      });
      return res.status(200).json({
        ok:true,
        state:'queued',
        completedScenes:null,
        progress:null,
        message:'Your movie is continuing from the preview you approved.',
        movieUrl:null,
        storybookUrl:null
      });
    }

    const output=job.output||{};
    let state=customerState(String(job.status||''),output);
    let assets={movie:false,storybook:false};
    if(state==='ready'){
      try{assets=await finalAssets(mcsJobId,token)}catch{}
      if(!assets.movie||!assets.storybook)state='needs_attention';
    }
    console.info('Order render status',{
      mcsJobId,
      runpodJobId:String(order.runpodJobId),
      platformStatus:String(job.status||''),
      businessStatus:String(output.status||''),
      state,
      completed:Number(output.completed||0)||null,
      error:String(output.error||job.error||'').slice(0,300)||null
    });
    const progress=job.progress??output.progress??null;
    const completed=Number(output.completed||0)||null;
    const safeProgress=typeof progress==='number'
      ?progress
      :typeof progress==='string'&&/^Scene \d{1,2} finished$/.test(progress)
        ?progress
        :null;
    return res.status(200).json({
      ok:true,
      state,
      completedScenes:completed,
      progress:safeProgress,
      message:state==='ready'
        ?'Your complete movie is ready.'
        :state==='needs_attention'
          ?'Your order is safe. The movie needs studio review before delivery.'
          :'Your movie is continuing from the preview you approved.',
      movieUrl:state==='ready'?`/api/order-media?session_id=${encodeURIComponent(sessionId)}&order_id=${encodeURIComponent(mcsJobId)}&kind=movie`:null,
      storybookUrl:state==='ready'?`/api/order-media?session_id=${encodeURIComponent(sessionId)}&order_id=${encodeURIComponent(mcsJobId)}&kind=storybook`:null
    });
  }catch(error){
    console.error('Order status lookup failed',error);
    return res.status(502).json({error:'Order status is temporarily unavailable'});
  }
}
