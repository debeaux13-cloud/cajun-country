import { getVercelOidcToken } from '@vercel/oidc';

async function getGatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY) return {token:process.env.AI_GATEWAY_API_KEY,auth:'api-key'};
  const oidc = await getVercelOidcToken();
  if(oidc) return {token:oidc,auth:'oidc'};
  throw new Error('Vercel AI Gateway auth missing');
}

async function makePlan(idea,moods){
  const {token,auth}=await getGatewayToken();
  const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({
      model:'openai/gpt-4o-mini',
      messages:[
        {role:'system',content:'You are Stage for Main Character Studios by Tiffani. Write exactly 18 numbered cinematic moving scenes for a 3-minute personalized animated movie. Every scene must contain visible character action and camera movement. Return only the numbered plan.'},
        {role:'user',content:'Idea: '+(idea||'')+'\nMoods: '+(moods||[]).join(', ')}
      ],
      temperature:.8
    })
  });
  const j=await r.json();
  if(!r.ok)throw new Error(j?.error?.message||'Stage provider error');
  return {plan:j?.choices?.[0]?.message?.content||'',auth};
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  try{
    const {plan,auth}=await makePlan(req.body?.idea,req.body?.moods);
    res.status(200).json({ok:true,plan,provider:'vercel-ai-gateway',auth});
  }catch(e){
    res.status(503).json({error:e.message});
  }
}
