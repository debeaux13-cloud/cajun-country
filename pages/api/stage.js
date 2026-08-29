import {getVercelOidcToken} from '@vercel/oidc';
import {normalizeMoods as canonicalMoods} from '../../lib/mcs-contract';
import {validateStageScenes} from '../../lib/stage-production';

const MAX_STORY_CHARACTERS=60000;
const MAX_MOODS=8;
const MAX_REFERENCE_BYTES=12*1024*1024;
const STORY_VIBES=new Set(['surprise me','funny','silly','dramatic','spooky','romantic']);

export const config={api:{bodyParser:{sizeLimit:'20mb'}}};

function normalizeStoryInput(value,{allowEmpty=false}={}){
  const text=String(value??'')
    .normalize('NFC')
    .replace(/\r\n?/g,'\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{4,}/g,'\n\n\n')
    .trim();
  if(!text&&!allowEmpty)throw new Error('Tell Stage at least one thing that happens in the story. Even one short sentence is enough.');
  if(text.length>MAX_STORY_CHARACTERS)throw new Error(`The typed story is longer than ${MAX_STORY_CHARACTERS.toLocaleString()} characters. Shorten it slightly so Stage can preserve every important part instead of silently cutting anything.`);
  return text;
}

function normalizeMoods(value){return canonicalMoods(value);}

function normalizeDraftAttempt(value){
  const attempt=value===undefined||value===null||value===''?1:Number(value);
  if(!Number.isInteger(attempt)||attempt<1||attempt>3)throw new Error('Draft attempt must be 1, 2, or 3');
  return attempt;
}

function normalizePriorStoryBriefs(value){
  if(!Array.isArray(value))return[];
  const briefs=value.map((brief,index)=>normalizeStoryInput(brief,{allowEmpty:true}).slice(0,6000)).filter(Boolean).slice(0,2);
  if(briefs.join('').length>12000)throw new Error('Prior story briefs are too long');
  return briefs;
}

function normalizeReferenceImage(value,{required=false}={}){
  const dataUrl=String(value||'').trim();
  if(!dataUrl){
    if(required)throw new Error('Add a clear photo so Stage can make the story around everyone in it.');
    return'';
  }
  const match=dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if(!match)throw new Error('The Stage reference must be a JPEG, PNG, or WebP photo.');
  const encoded=match[2].replace(/\s+/g,'');
  const byteLength=Buffer.from(encoded,'base64').length;
  if(!byteLength)throw new Error('The Stage reference photo is empty.');
  if(byteLength>MAX_REFERENCE_BYTES)throw new Error('Please choose a photo smaller than 12 MB.');
  return`data:${match[1].toLowerCase().replace('image/jpg','image/jpeg')};base64,${encoded}`;
}

async function getGatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY)return{token:process.env.AI_GATEWAY_API_KEY,auth:'api-key'};
  const oidc=await getVercelOidcToken();
  if(oidc)return{token:oidc,auth:'oidc'};
  throw new Error('Vercel AI Gateway auth missing');
}

const sourceFactSchema={
  type:'object',
  additionalProperties:false,
  properties:{
    id:{type:'string'},
    category:{type:'string',enum:['character','key_object','major_event','turning_point','climax','ending','imagination_rule']},
    detail:{type:'string'},
    sourceOrder:{type:'integer',minimum:1}
  },
  required:['id','category','detail','sourceOrder']
};

const ledgerSchema={
  type:'object',
  additionalProperties:false,
  properties:{
    creativeMode:{type:'string',enum:['my_story','make_for_me']},
    draftAttempt:{type:'integer',minimum:1,maximum:3},
    inputScale:{type:'string',enum:['tiny','short','balanced','long','very_long']},
    visibleCast:{type:'array',items:{type:'string'}},
    namedCharacters:{type:'array',items:{type:'string'}},
    keyObjects:{type:'array',items:{type:'string'}},
    imaginationRules:{type:'array',items:{type:'string'}},
    orderedMajorEvents:{type:'array',items:{type:'string'}},
    turningPoints:{type:'array',items:{type:'string'}},
    originalClimax:{type:'string'},
    originalEnding:{type:'string'},
    requiredSourceFacts:{type:'array',minItems:1,items:sourceFactSchema},
    preservationSummary:{type:'string'}
  },
  required:['creativeMode','draftAttempt','inputScale','visibleCast','namedCharacters','keyObjects','imaginationRules','orderedMajorEvents','turningPoints','originalClimax','originalEnding','requiredSourceFacts','preservationSummary']
};

const stageSceneSchema={
  type:'object',
  additionalProperties:false,
  properties:{
    sceneNumber:{type:'integer',minimum:1,maximum:18},
    title:{type:'string'},
    location:{type:'string'},
    narration:{type:'string'},
    visual:{type:'string'},
    sourceFactIds:{type:'array',items:{type:'string'}}
  },
  required:['sceneNumber','title','location','narration','visual','sourceFactIds']
};

const stageSchema={
  type:'object',
  additionalProperties:false,
  properties:{
    title:{type:'string'},
    creativeMode:{type:'string',enum:['my_story','make_for_me']},
    draftAttempt:{type:'integer',minimum:1,maximum:3},
    storyBrief:{type:'string'},
    differenceFromPriorDrafts:{type:'string'},
    sourceLedger:ledgerSchema,
    scenes:{type:'array',minItems:18,maxItems:18,items:stageSceneSchema}
  },
  required:['title','creativeMode','draftAttempt','storyBrief','differenceFromPriorDrafts','sourceLedger','scenes']
};

function stripFence(value){
  return String(value??'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
}

function conciseValidationFailure(error){
  return String(error?.message||'structured output was invalid').replace(/\s+/g,' ').trim().slice(0,320);
}

async function requestStageCompletion(token,messages){
  const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({
      model:'openai/gpt-5.4',
      max_completion_tokens:20000,
      response_format:{type:'json_schema',json_schema:{name:'mcs_stage_plan',strict:true,schema:stageSchema}},
      messages
    })
  });
  let payload;
  try{payload=await response.json()}catch{throw new Error('Stage provider returned an unreadable response')}
  if(!response.ok)throw new Error(payload?.error?.message||'Stage provider error');
  return String(payload?.choices?.[0]?.message?.content||'');
}

function cleanStringArray(value){
  return Array.isArray(value)?value.map(item=>String(item??'').trim()).filter(Boolean):[];
}

function validateLedger(value,creativeMode,draftAttempt){
  const facts=Array.isArray(value?.requiredSourceFacts)?value.requiredSourceFacts.map((fact,index)=>({
    id:String(fact?.id||`FACT-${String(index+1).padStart(3,'0')}`).trim(),
    category:String(fact?.category||'major_event').trim(),
    detail:String(fact?.detail||'').trim(),
    sourceOrder:Number(fact?.sourceOrder||index+1)
  })):[];
  if(!facts.length)throw new Error('Stage did not create a source-preservation ledger');
  const ids=new Set();
  for(const fact of facts){
    if(!fact.id||ids.has(fact.id))throw new Error('Stage source-preservation ledger has duplicate fact IDs');
    if(!['character','key_object','major_event','turning_point','climax','ending','imagination_rule'].includes(fact.category))throw new Error(`Stage source fact ${fact.id} has an invalid category`);
    if(fact.detail.length<2)throw new Error(`Stage source fact ${fact.id} is incomplete`);
    if(!Number.isInteger(fact.sourceOrder)||fact.sourceOrder<1)throw new Error(`Stage source fact ${fact.id} has invalid order`);
    ids.add(fact.id);
  }
  return{
    creativeMode:String(value?.creativeMode||creativeMode),
    draftAttempt:Number(value?.draftAttempt||draftAttempt),
    inputScale:String(value?.inputScale||'balanced'),
    visibleCast:cleanStringArray(value?.visibleCast),
    namedCharacters:cleanStringArray(value?.namedCharacters),
    keyObjects:cleanStringArray(value?.keyObjects),
    imaginationRules:cleanStringArray(value?.imaginationRules),
    orderedMajorEvents:cleanStringArray(value?.orderedMajorEvents),
    turningPoints:cleanStringArray(value?.turningPoints),
    originalClimax:String(value?.originalClimax||'').trim(),
    originalEnding:String(value?.originalEnding||'').trim(),
    requiredSourceFacts:facts.sort((a,b)=>a.sourceOrder-b.sourceOrder),
    preservationSummary:String(value?.preservationSummary||'').trim()
  };
}

function normalizePriorSourceLedgers(value,creativeMode,draftAttempt){
  const entries=value===undefined||value===null?[]:value;
  if(!Array.isArray(entries))throw new Error('Prior source ledgers must be an array');
  if(entries.length>2)throw new Error('Prior source ledgers can contain at most two drafts');
  let serialized;
  try{serialized=JSON.stringify(entries)}catch{throw new Error('Prior source ledgers are invalid')}
  if(serialized.length>150000)throw new Error('Prior source ledgers are too large');
  const ledgers=entries.map((entry,index)=>{
    let raw=entry;
    if(typeof raw==='string'){
      try{raw=JSON.parse(raw)}catch{throw new Error(`Prior source ledger ${index+1} is invalid JSON`)}
    }
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error(`Prior source ledger ${index+1} is invalid`);
    let ledger;
    try{ledger=validateLedger(raw,String(raw.creativeMode||creativeMode),Number(raw.draftAttempt||index+1))}catch(error){throw new Error(`Prior source ledger ${index+1} failed validation: ${error.message}`)}
    if(ledger.creativeMode!==creativeMode)throw new Error(`Prior source ledger ${index+1} uses a different creative mode`);
    if(ledger.draftAttempt!==index+1)throw new Error(`Prior source ledger ${index+1} has the wrong draft number`);
    return ledger;
  });
  const requiredCount=Math.max(0,draftAttempt-1);
  if(ledgers.length!==requiredCount)throw new Error(`Prior source ledgers must include exactly ${requiredCount} earlier draft${requiredCount===1?'':'s'}`);
  return ledgers;
}

function validateCrossDraftFacts(sourceLedger,priorSourceLedgers,creativeMode){
  if(!priorSourceLedgers.length)return;
  const canonical=priorSourceLedgers[0];
  if(creativeMode==='my_story'){
    const currentById=new Map(sourceLedger.requiredSourceFacts.map(fact=>[fact.id,fact]));
    if(currentById.size!==canonical.requiredSourceFacts.length)throw new Error('Stage alternate changed the original source fact count');
    for(const priorFact of canonical.requiredSourceFacts){
      const current=currentById.get(priorFact.id);
      if(!current)throw new Error(`Stage alternate lost original source fact ${priorFact.id}`);
      if(current.category!==priorFact.category)throw new Error(`Stage alternate changed the category of ${priorFact.id}`);
      if(current.detail!==priorFact.detail)throw new Error(`Stage alternate changed the detail of ${priorFact.id}`);
    }
    return;
  }
  const priorCast=canonical.visibleCast;
  if(sourceLedger.visibleCast.length!==priorCast.length||sourceLedger.visibleCast.some((item,index)=>item!==priorCast[index]))throw new Error('Stage alternate changed or omitted a visible photo subject');
}

function normalizedWords(value){
  return new Set(String(value||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(word=>word.length>2));
}

function wordSimilarity(left,right){
  const a=normalizedWords(left);const b=normalizedWords(right);
  if(!a.size||!b.size)return 0;
  let overlap=0;for(const word of a)if(b.has(word))overlap++;
  return overlap/(a.size+b.size-overlap);
}

function phraseAppears(text,value){
  const normalize=input=>String(input||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const phrase=normalize(value);
  return Boolean(phrase)&&` ${normalize(text)} `.includes(` ${phrase} `);
}

export function validatePhotoCastCoverage(sourceLedger,hasReferenceImage){
  if(!hasReferenceImage)return;
  if(!sourceLedger.visibleCast.length)throw new Error('Stage did not identify the visible starring cast');
  const characterFacts=sourceLedger.requiredSourceFacts.filter(fact=>fact.category==='character');
  const usedFactIds=new Set();
  const visibleRoles=[...sourceLedger.visibleCast].sort((left,right)=>right.length-left.length);
  const missingVisibleCast=visibleRoles.filter(role=>{
    const match=characterFacts.find(fact=>!usedFactIds.has(fact.id)&&phraseAppears(fact.detail,role));
    if(match)usedFactIds.add(match.id);
    return!match;
  });
  if(missingVisibleCast.length)throw new Error(`Stage did not preserve visible stars in character facts: ${missingVisibleCast.join(', ')}`);
}

function validateStageResult(value,creativeMode,draftAttempt,priorStoryBriefs,priorSourceLedgers,hasReferenceImage){
  if(!Array.isArray(value?.scenes)||value.scenes.length!==18)throw new Error('Stage must return exactly 18 scenes');
  if(String(value?.creativeMode||'')!==creativeMode)throw new Error('Stage returned the wrong creative mode');
  if(Number(value?.draftAttempt)!==draftAttempt)throw new Error('Stage returned the wrong draft attempt');
  const sourceLedger=validateLedger(value.sourceLedger,creativeMode,draftAttempt);
  if(sourceLedger.creativeMode!==creativeMode)throw new Error('Stage source ledger has the wrong creative mode');
  if(sourceLedger.draftAttempt!==draftAttempt)throw new Error('Stage source ledger has the wrong draft attempt');
  validateCrossDraftFacts(sourceLedger,priorSourceLedgers,creativeMode);
  validatePhotoCastCoverage(sourceLedger,hasReferenceImage);
  const validFactIds=new Set(sourceLedger.requiredSourceFacts.map(fact=>fact.id));
  const coveredFactIds=new Set();
  const firstSceneByFact=new Map();
  const scenes=value.scenes.map((scene,index)=>{
    const sceneNumber=index+1;
    if(Number(scene?.sceneNumber)!==sceneNumber)throw new Error(`Stage scene ${sceneNumber} numbering is invalid`);
    const title=String(scene?.title||'').trim();
    const location=String(scene?.location||'').trim();
    const narration=String(scene?.narration||'').trim();
    const visual=String(scene?.visual||'').trim();
    if(title.length<2||location.length<2||narration.length<20||visual.length<20)throw new Error(`Stage scene ${sceneNumber} is incomplete`);
    const narrationWords=narration.split(/\s+/).filter(Boolean).length;
    if(narrationWords<16||narrationWords>22)throw new Error(`Stage scene ${sceneNumber} narration is outside the safe ten-second range`);
    if(/^\s*(scene|chapter)\s*\d+/i.test(narration))throw new Error(`Stage scene ${sceneNumber} narration contains an internal label`);
    const sourceFactIds=cleanStringArray(scene?.sourceFactIds);
    for(const id of sourceFactIds){
      if(!validFactIds.has(id))throw new Error(`Stage scene ${sceneNumber} references unknown source fact ${id}`);
      coveredFactIds.add(id);
      if(!firstSceneByFact.has(id))firstSceneByFact.set(id,sceneNumber);
    }
    return{sceneNumber,title,location,narration,visual,sourceFactIds};
  });
  const missing=sourceLedger.requiredSourceFacts.filter(fact=>!coveredFactIds.has(fact.id));
  if(missing.length)throw new Error(`Stage omitted required source facts: ${missing.map(fact=>fact.id).join(', ')}`);
  if(creativeMode==='my_story'){
    const chronological=sourceLedger.requiredSourceFacts.filter(fact=>['major_event','turning_point','climax','ending'].includes(fact.category));
    let lastScene=0;
    for(const fact of chronological){
      const firstScene=firstSceneByFact.get(fact.id)||0;
      if(firstScene<lastScene)throw new Error(`Stage changed the customer's source order near ${fact.id}`);
      lastScene=firstScene;
    }
  }
  const storyBrief=String(value?.storyBrief||'').trim();
  if(storyBrief.length<20)throw new Error('Stage did not return a complete story brief');
  const differenceFromPriorDrafts=String(value?.differenceFromPriorDrafts||'').trim();
  if(draftAttempt>1&&differenceFromPriorDrafts.length<30)throw new Error('Stage did not explain how the alternate draft is materially different');
  if(draftAttempt>1&&priorStoryBriefs.some(brief=>wordSimilarity(storyBrief,brief)>.82))throw new Error('Stage alternate draft is too similar to a prior draft');
  validateStageScenes(scenes);
  return{title:String(value?.title||'Main Character Studios Movie').trim(),creativeMode,draftAttempt,storyBrief,differenceFromPriorDrafts,sourceLedger,scenes};
}

function formatPlan(scenes){
  return scenes.map(scene=>`${scene.sceneNumber}. ${scene.title} — ${scene.location}\nNarration: ${scene.narration}\nVisual: ${scene.visual}`).join('\n\n');
}

async function makePlan(idea,moods,imageValue,draftAttemptValue,priorStoryBriefsValue,priorSourceLedgersValue){
  const normalizedIdea=normalizeStoryInput(idea,{allowEmpty:true});
  const creativeMode=normalizedIdea?'my_story':'make_for_me';
  const normalizedMoods=normalizeMoods(moods);
  const draftAttempt=normalizeDraftAttempt(draftAttemptValue);
  const priorStoryBriefs=normalizePriorStoryBriefs(priorStoryBriefsValue);
  const priorSourceLedgers=normalizePriorSourceLedgers(priorSourceLedgersValue,creativeMode,draftAttempt);
  const referenceImage=normalizeReferenceImage(imageValue,{required:creativeMode==='make_for_me'});
  const{token,auth}=await getGatewayToken();
  const system=`You are Stage, the story partner for Main Character Studios by Tiffani. Convert the customer's exact typed idea into a genuinely entertaining THREE-MINUTE personalized animated movie plan with exactly 18 numbered scenes of about 10 seconds each.

CREATIVE MODES:
- Infer the mode only from the trimmed customer text. Empty text means creativeMode "make_for_me". Any nonempty text, even one word such as "rodeo," means creativeMode "my_story".
- creativeMode "my_story": the customer supplied at least a seed. Preserve it under the source rules below, whether it is one word, one child-style sentence, or a very long story.
- creativeMode "make_for_me": no text was supplied and the uploaded photo supplies the starring cast. Identify every principal visible person or animal as a separate generic visual role, place those roles in visibleCast, and invent a complete causal story around all of them. Never invent personal names for visible people or animals. Refer to them with stable generic roles such as "the woman," "the older child," "the black-and-tan dog," or "the tabby cat" until the production subject roster can bind them.
- In make_for_me mode the theme may be completely empty. A photo alone is sufficient: invent the strongest fun premise around every principal visible subject without treating the absence of text as an error or as a source fact.
- Whenever a photo is supplied in either mode, inventory every principal visible person and animal in visibleCast and keep their age/species roles distinct.

ALTERNATE DRAFT RULES:
- draftAttempt 1 is the first treatment. draftAttempt 2 or 3 must be materially different from every supplied priorStoryBrief, never a cosmetic paraphrase or renamed set of scenes.
- In my_story mode, the earliest priorSourceLedger is canonical. Copy every requiredSourceFacts ID, category, and detail VERBATIM into this draft's sourceLedger; do not add, remove, renumber, recategorize, or reword facts. Keep the customer's ending, but use a materially different cinematic treatment and structure: change at least three of the opening device, scene grouping, setting progression, obstacle-escalation pattern, midpoint framing, climax staging, or visual motif.
- In make_for_me mode, invented plot facts may change between drafts, but copy the earliest priorSourceLedger visibleCast entries VERBATIM and include every visible star. Retain the selected vibe and must-have photo details while changing at least three of the central goal, inciting incident, main obstacle, setting progression, climax mechanism, or ending payoff.
- differenceFromPriorDrafts must state the concrete structural or plot differences. Do not claim a difference that is not visible in the 18 scenes.

AGE, SPECIES, AND RELATIONSHIP SAFETY:
- Use only visible evidence for age group and species. Children remain children with childlike dialogue, roles, choices, and meaningful agency. Never put a child in adult romance, an adult job, a parenting role, alcohol use, or any adult situation.
- Adults remain adults. Animals remain animals with their own anatomy and species-appropriate movement even when the fantasy lets them talk or act heroically.
- In mixed groups, keep every child's, adult's, and animal's role coherent and distinct. Never invent family, romantic, ownership, school, or caregiving relationships that the customer did not state.
- The selected vibe guides invention. Supported vibes are exactly: surprise me, funny, silly, dramatic, spooky, and romantic. Spooky may be suspenseful but never graphic, cruel, sexual, or adult. Romantic is gentle adult romance only when the visible cast is clearly adult; for children, families, or animals, interpret romantic as warm love, friendship, loyalty, or affection with no adult situations.

SOURCE-PRESERVATION RULES:
- First build sourceLedger from the customer's actual words and, whenever a photo is supplied in either creative mode, every principal visible person and animal. Every visible subject and every explicitly named or specifically identified character, key object, major event, turning point, climax, ending, and imaginative rule must have its own requiredSourceFacts entry with a stable FACT-### ID. Give each visibleCast entry its own character FACT whose detail repeats that visibleCast label verbatim, so coverage is auditable. Repeated wording, minor gestures, and incidental dialogue may be summarized rather than logged as separate facts.
- Stage is the story brain, not a transcription service. Make the strongest coherent plot without asking follow-up questions: repair grammar, collapse repetition, resolve accidental contradictions, infer missing causal transitions, and reorder obviously out-of-order fragments.
- A child's impossible event, invented creature, deliberate funny contradiction, or dream logic is imaginative story truth, not an error to erase. Preserve the cast, premise, favorite weird specifics, requested key moments, and intended ending. Repair accidental incoherence without flattening the fantasy.
- sourceOrder means the intended causal story order after resolving the customer's fragments, not blindly the order in which an unfinished thought happened to be typed.
- Never replace a specific character, object, creature, power, location, event, relationship, joke, or ending with a generic equivalent.
- For a very short idea, preserve every supplied fact and expand it into a real goal, obstacle, escalating attempts, setback, climax, payoff, and warm resolution. Added material must grow causally from the idea; do not use generic filler or eighteen variations of one action.
- For a long or very long story, keep ALL named characters, key objects, intended major events, turning points, climax, and the customer's ending. Compress repeated description, travel, dialogue, and secondary explanation. Combine adjacent source events inside the same scene when necessary, and reorder fragments only when needed to recover the coherent intended sequence. Never silently drop a core beat.
- sourceFactIds on the scenes are an auditable coverage map. Every required source fact ID must appear in at least one scene. Major events, turning points, climax, and ending must first appear in source order. Do not invent fact IDs.

FILM RULES:
- This is a real short film, not a slideshow. Use setup, discovery, escalation, complications, emotional turns, climax, payoff, and ending.
- Scenes 1-6 are the free 60-second opening. They must form a compelling mini-act and end on an irresistible continuation beat, not a conclusion.
- Scenes 7-18 complete the same story with escalation, a real climax, and the customer's satisfying emotional ending.
- Every scene must causally lead into the next: setup creates the goal, each attempt creates a consequence, the setback changes the plan, and the climax resolves the central problem. No disconnected events, unexplained jumps, random props, or filler.
- Every scene materially changes what is happening through location, blocking, objective, obstacle, prop, supporting character, discovery, or emotion. Do not use filler whose only change is camera angle.
- Give enough narration for the full three minutes. Each scene needs 16-22 naturally spoken words per 10-second scene. Never narrate Scene 1, Scene 2, chapter labels, or production notes.
- Narration describes story and emotion, never camera directions. The visual must match it exactly.
- Use polished cinematic animated-feature storytelling: dimensional and expressive, between flat children's cartoon and photoreal live action, with detailed environments, depth, meaningful props, and supporting characters where the story calls for them.
- The main character visibly moves, travels, reacts, and physically interacts. Moving scenery alone does not count.
- Preserve every uploaded subject's identity and anatomy. Keep secondary characters separate; never merge or hybridize bodies or transfer anatomy.

Return only the strict JSON requested by the schema. Do not add prose outside it.`;
  const userText=`CREATIVE MODE: ${creativeMode}\nDRAFT ATTEMPT: ${draftAttempt}\n\nCUSTOMER'S ORIGINAL TYPED STORY OR THEME (preserve its required content and intended sequence):\n${normalizedIdea||'[No theme supplied. Invent an original story from the photo alone.]'}\n\nPRIOR STORY BRIEFS TO AVOID REPEATING:\n${priorStoryBriefs.length?priorStoryBriefs.map((brief,index)=>`Prior ${index+1}: ${brief}`).join('\n\n'):'none'}\n\nPRIOR SOURCE LEDGERS FOR FACT STABILITY:\n${priorSourceLedgers.length?JSON.stringify(priorSourceLedgers):'none'}\n\nSELECTED MOODS:\n${normalizedMoods.length?normalizedMoods.join(', '):'none selected'}${referenceImage?'\n\nUse every principal person or animal visible in the attached photo as a distinct star. Do not give any of them an invented personal name.':''}`;
  const userContent=referenceImage?[{type:'text',text:userText},{type:'image_url',image_url:{url:referenceImage}}]:userText;
  const baseMessages=[{role:'system',content:system},{role:'user',content:userContent}];
  let previousOutput='';
  let lastValidationError;
  for(let attempt=0;attempt<2;attempt++){
    const messages=attempt===0?baseMessages:[...baseMessages,
      {role:'assistant',content:previousOutput||'{}'},
      {role:'user',content:`REPAIR ONLY. The previous structured plan failed validation: ${conciseValidationFailure(lastValidationError)}. Return one complete corrected JSON object matching the same schema. Keep the exact original customer text, photo, inferred mode, draft number, prior briefs, prior source ledgers, vibes, source facts, and plot choices; change only what is necessary to fix this validation failure.`}
    ];
    previousOutput=await requestStageCompletion(token,messages);
    try{
      let parsed;
      try{parsed=JSON.parse(stripFence(previousOutput))}catch{throw new Error('Stage returned invalid structured story data')}
      const result=validateStageResult(parsed,creativeMode,draftAttempt,priorStoryBriefs,priorSourceLedgers,Boolean(referenceImage));
      return{plan:formatPlan(result.scenes),scenes:result.scenes,sourceLedger:result.sourceLedger,title:result.title,storyBrief:result.storyBrief,differenceFromPriorDrafts:result.differenceFromPriorDrafts,creativeMode:result.creativeMode,draftAttempt:result.draftAttempt,auth};
    }catch(error){
      lastValidationError=error;
      if(attempt===1)throw error;
    }
  }
  throw lastValidationError;
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const trigger=req.body?.trigger==='ai_chat'?'ai_chat':'story_button';
  try{
    console.log('[stage-automation]',JSON.stringify({event:'started',trigger,draftAttempt:Number(req.body?.draftAttempt)||1,hasPhoto:Boolean(req.body?.image)}));
    const{plan,scenes,sourceLedger,title,storyBrief,differenceFromPriorDrafts,creativeMode,draftAttempt,auth}=await makePlan(req.body?.idea,req.body?.moods,req.body?.image,req.body?.draftAttempt,req.body?.priorStoryBriefs,req.body?.priorSourceLedgers);
    console.log('[stage-automation]',JSON.stringify({event:'completed',trigger,draftAttempt,title}));
    return res.status(200).json({ok:true,plan,scenes,sourceLedger,title,storyBrief,differenceFromPriorDrafts,creativeMode,draftAttempt,provider:'vercel-ai-gateway',auth});
  }catch(error){
    console.error('[stage-automation]',JSON.stringify({event:'failed',trigger,error:String(error?.message||error).slice(0,300)}));
    const status=/at least one thing|longer than|draft attempt|prior story|prior source|add a clear photo|reference|photo/i.test(String(error?.message||''))?400:503;
    return res.status(status).json({error:error.message});
  }
}
