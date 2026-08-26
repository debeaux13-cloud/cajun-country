import { getVercelOidcToken } from '@vercel/oidc';

async function getGatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY) return {token:process.env.AI_GATEWAY_API_KEY,auth:'api-key'};
  const oidc=await getVercelOidcToken();
  if(oidc)return {token:oidc,auth:'oidc'};
  throw new Error('Vercel AI Gateway auth missing');
}

async function makePlan(idea,moods){
  const {token,auth}=await getGatewayToken();
  const system=`You are Stage, the story partner for Main Character Studios by Tiffani.
Turn the customer's idea into a genuinely entertaining THREE-MINUTE personalized animated movie plan with exactly 18 numbered scenes, about 10 seconds each.

This is not a slideshow and not 18 variations of the same portrait. Write a real short-film story with setup, discovery, escalation, complications, emotional turns, climax, payoff and ending.

STORY RULES:
- Scenes 1-6 are the free 60-second opening. They must form a compelling mini-act and end on an irresistible continuation beat, not a conclusion.
- Scenes 7-18 complete the same story with escalation, a real climax and a satisfying emotional ending.
- Every scene must materially change what is happening. Change location, blocking, objective, obstacle, prop, supporting character, discovery or emotional state as the story naturally requires.
- Do not write filler scenes whose only change is camera angle.
- Give enough story for narration throughout the full 3 minutes. Each scene should contain roughly 2-4 natural spoken sentences, not a label plus one thin sentence.
- Never narrate the words Scene 1, Scene 2, etc. Numbering is only for the editable plan.
- Narration describes story and emotion, not camera directions.
- Visual directions must match the narration exactly.

VISUAL TARGET:
- polished cinematic animated-feature look: dimensional and expressive, between flat children's cartoon and photoreal live action.
- detailed lived-in environments, foreground/background depth, meaningful props and supporting characters where the story calls for them.
- the main character must visibly move, travel, react and physically interact; wind, zooms or moving scenery do not count as character action.
- preserve the uploaded subject's identity and anatomy across every scene. Never hybridize the hero with another animal/person/object. A dog near a duck must remain a dog: no beak, webbed feet, feathers, duck tail or borrowed anatomy.
- secondary characters must remain visually separate bodies from the hero.

Return a clean customer-readable screenplay-style plan with exactly 18 numbered entries. For each entry use this format:
1. Short scene title — LOCATION
Narration: 2-4 natural sentences.
Visual: one detailed sentence describing the exact visible action, environment, props/supporting characters and emotional beat.

Do not output JSON. Do not add an intro or outro outside the 18 entries.`;
  const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({model:'openai/gpt-4o-mini',messages:[
      {role:'system',content:system},
      {role:'user',content:'Customer idea: '+(idea||'')+'\nSelected moods: '+(moods||[]).join(', ')}
    ],temperature:.9})
  });
  const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||'Stage provider error');
  return {plan:j?.choices?.[0]?.message?.content||'',auth};
}
export default async function handler(req,res){if(req.method!=='POST')return res.status(405).json({error:'POST only'});try{const{plan,auth}=await makePlan(req.body?.idea,req.body?.moods);res.status(200).json({ok:true,plan,provider:'vercel-ai-gateway',auth})}catch(e){res.status(503).json({error:e.message})}}
