import { getVercelOidcToken } from '@vercel/oidc';

export default async function handler(req,res){
  try{
    const token=process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken();
    if(!token) return res.status(503).json({ok:false,error:'missing auth'});
    const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({model:'openai/gpt-4o-mini',messages:[{role:'system',content:'Return exactly the word OK.'},{role:'user',content:'Production Stage connectivity test.'}],temperature:0})
    });
    const j=await r.json();
    return res.status(r.ok?200:502).json({ok:r.ok,status:r.status,auth:process.env.AI_GATEWAY_API_KEY?'api-key':'oidc',reply:j?.choices?.[0]?.message?.content||null,error:j?.error?.message||null});
  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}
