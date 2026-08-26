import { getVercelOidcToken } from '@vercel/oidc';

async function getGatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY) return {token:process.env.AI_GATEWAY_API_KEY,auth:'api-key'};
  const oidc=await getVercelOidcToken();
  if(oidc)return {token:oidc,auth:'oidc'};
  throw new Error('Vercel AI Gateway auth missing');
}

async function makePlan(idea,moods){
  const {token,auth}=await getGatewayToken();
  const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({model:'openai/gpt-4o-mini',messages:[
      {role:'system',content:'You are Stage for Main Character Studios by Tiffani. Help the customer shape their idea into exactly 18 numbered cinematic moving scenes for a 3-minute personalized animated movie, about 10 seconds per scene. Scenes 1-6 are the complete 60-second free preview: they must hook emotionally, clearly establish the main character, visibly advance the story, and end at a natural irresistible continuation point rather than a full ending. Scenes 7-18 are the paid continuation that completes the same story with a middle, climax, emotional payoff, and satisfying ending. Every scene must visibly match its narration, contain purposeful character action and position change, environmental interaction, and supportive camera movement. Keep character identity and story facts consistent. Use a polished animated-feature tone between flat kid-cartoon and photoreal live action. Return only the 18 numbered scenes.'},
      {role:'user',content:'Idea: '+(idea||'')+'\nMoods: '+(moods||[]).join(', ')}
    ],temperature:.8})
  });
  const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||'Stage provider error');
  return {plan:j?.choices?.[0]?.message?.content||'',auth};
}
export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'POST only'});try{const{plan,auth}=await makePlan(req.body?.idea,req.body?.moods);res.status(200).json({ok:true,plan,provider:'vercel-ai-gateway',auth})}catch(e){res.status(503).json({error:e.message})}}
