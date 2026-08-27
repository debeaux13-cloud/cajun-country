import {getVercelOidcToken} from '@vercel/oidc';

export const config={api:{bodyParser:{sizeLimit:'20mb'}}};

async function gatewayAuth(){
  if(process.env.AI_GATEWAY_API_KEY)return{token:process.env.AI_GATEWAY_API_KEY,auth:'api-key'};
  const token=await getVercelOidcToken().catch(()=>null);
  if(token)return{token,auth:'oidc'};
  throw new Error('Vercel AI Gateway auth missing');
}

function cleanText(value,max=4000){
  return String(value??'').normalize('NFC').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  try{
    const message=cleanText(req.body?.message);
    const vibe=cleanText(req.body?.vibe,80);
    const image=String(req.body?.image||'');
    if(image&&!/^data:image\/(?:jpeg|png|webp);base64,/i.test(image))return res.status(400).json({error:'Unsupported image'});
    if(!image&&!message)return res.status(400).json({error:'Add a photo or message first'});
    const history=Array.isArray(req.body?.history)?req.body.history.slice(-8).map(item=>({
      role:item?.role==='assistant'?'assistant':'user',
      content:cleanText(item?.content,1200)
    })).filter(item=>item.content):[];
    const{token,auth}=await gatewayAuth();
    const system=`You are Stage, the warm, concise AI story director for Main Character Studios by Tiffani. This is a real customer chat before story generation.

Study the uploaded photo carefully. Inventory every principal visible person and animal separately using stable, respectful descriptions based on visible evidence: approximate age group, species, ear/tail/body/coat markers for animals, and distinguishing clothing or placement for people. Never identify a real person, invent a name, invent a breed with false confidence, or invent relationships.

Tell the customer what you understand in plain language. If one important fact is genuinely unclear and would materially change the story, ask exactly ONE short question. Examples: who two people are to each other, which subject should lead, or whether an unclear animal is a dog or cat. Never demand names and never block a customer who chose a preset vibe; generic roles are sufficient.

Accept messy, short, child-written, contradictory, or very long ideas. Explain briefly that you will preserve intended characters and key events, repair accidental confusion, expand short ideas, and compress long ideas into one coherent three-minute story. Children remain children; animals retain correct species and anatomy. If the customer corrects your understanding, acknowledge and use the correction.

Return strict JSON only.`;
    const userParts=[{type:'text',text:`Selected story type: ${vibe||'none yet'}\nCustomer message: ${message||'[Photo uploaded. Tell the customer who and what you can see, then ask one useful question only if truly needed.]'}`}];
    if(image)userParts.push({type:'image_url',image_url:{url:image}});
    const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'openai/gpt-5.4',
        messages:[{role:'system',content:system},...history,{role:'user',content:userParts}],
        response_format:{type:'json_schema',json_schema:{name:'stage_chat',strict:true,schema:{
          type:'object',additionalProperties:false,
          properties:{
            reply:{type:'string'},
            castSummary:{type:'array',items:{type:'string'}},
            clarificationNeeded:{type:'boolean'},
            readyToCreate:{type:'boolean'}
          },
          required:['reply','castSummary','clarificationNeeded','readyToCreate']
        }}}
      })
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload?.error?.message||`Stage chat failed (${response.status})`);
    const raw=payload?.choices?.[0]?.message?.content;
    const result=typeof raw==='string'?JSON.parse(raw):raw;
    if(!result?.reply)throw new Error('Stage chat returned no reply');
    return res.status(200).json({...result,provider:'vercel-ai-gateway',auth});
  }catch(error){
    console.error('Stage chat failed',error);
    return res.status(502).json({error:String(error?.message||error).slice(0,300)});
  }
}
