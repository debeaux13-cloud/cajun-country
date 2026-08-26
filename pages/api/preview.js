import crypto from 'crypto';
import{put}from'@vercel/blob';
import{getVercelOidcToken}from'@vercel/oidc';
import{runpod}from'./_runpod';
import{compileStoryScreenplay}from'./_story-screenplay';

export const config={api:{bodyParser:{sizeLimit:'15mb'}}};

async function store(id,kind,data,type){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Blob storage token missing');
  return put(`mcs/jobs/${id}/${kind}.bin`,data,{access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:type});
}

async function gatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY)return process.env.AI_GATEWAY_API_KEY;
  const oidc=await getVercelOidcToken();
  if(oidc)return oidc;
  throw new Error('Vercel AI Gateway auth missing');
}

const subjectSchema={
  type:'object',additionalProperties:false,
  properties:{
    referencePosition:{type:'string'},
    kind:{type:'string',enum:['person','dog','cat','animal']},
    species:{type:'string'},
    primaryBreedGuess:{type:'string'},
    breedConfidence:{type:'string',enum:['high','medium','low','not_applicable']},
    keyMarkers:{type:'array',items:{type:'string'}},
    identityDescription:{type:'string'},
    uncertainDetails:{type:'array',items:{type:'string'}}
  },
  required:['referencePosition','kind','species','primaryBreedGuess','breedConfidence','keyMarkers','identityDescription','uncertainDetails']
};

const identitySchema={
  type:'object',additionalProperties:false,
  properties:{
    subjectCount:{type:'integer',minimum:1,maximum:6},
    subjectType:{type:'string',enum:['person','pet','people','pets','person_and_pet','mixed']},
    species:{type:'string'},
    primaryBreedGuess:{type:'string'},
    breedConfidence:{type:'string',enum:['high','medium','low','not_applicable']},
    keyMarkers:{type:'array',items:{type:'string'}},
    breedAlternatives:{type:'array',items:{type:'string'}},
    identityDescription:{type:'string'},
    uncertainDetails:{type:'array',items:{type:'string'}},
    subjects:{type:'array',minItems:1,maxItems:6,items:subjectSchema}
  },
  required:['subjectCount','subjectType','species','primaryBreedGuess','breedConfidence','keyMarkers','breedAlternatives','identityDescription','uncertainDetails','subjects']
};

async function analyzeReference(dataUrl){
  const token=await gatewayToken();
  const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({
      model:'openai/gpt-4o-mini',
      response_format:{type:'json_schema',json_schema:{name:'mcs_subject_identity',strict:true,schema:identitySchema}},
      messages:[{role:'system',content:`You are the identity intake inspector for Main Character Studios by Tiffani. Describe only the principal subject or subjects visibly present in the uploaded customer reference. Produce a compact production identity lock, not a story and not a guessed biography.

For every pet, identify species first and then identify breed or breed type from visible physical markers, never overall vibe. For dogs explicitly inspect: (1) ear type: cropped/erect, natural prick, semi-erect, or floppy/pendant; (2) tail type: docked, natural long, curled, or bobbed; (3) build: lean/athletic, stocky, elongated, or toy-sized; (4) coat pattern: solid, bicolor with rust/tan points, brindle, merle, or spotted; (5) muzzle: long/tapered, blocky/square, or short/brachycephalic; and (6) coat length/texture. For cats explicitly inspect: ear type including pointed, folded, or tufted; coat pattern including solid, tabby, calico, tortoiseshell, colorpoint, or tuxedo; coat length; body build; face shape; and tail length/type. Put the most likely identification in primaryBreedGuess, rate confidence honestly, list the visible evidence in keyMarkers, and for medium/low confidence list the top alternatives. Do not default to mixed breed unless visible markers genuinely conflict.

For every other animal, use the same layered morphology process rather than a pet-only shortcut. First isolate the principal subject from background, lighting, artistic style, and scale. Read its silhouette and structural blueprint: skeletal proportions, limb count and configuration, body length-to-height ratio, posture, tail, and paw, hoof, claw, fin, wing, or other locomotion structures. Detect anatomical landmarks such as head and snout shape, ear placement and conformation, eye spacing, neck, joints, and the presence and type of fur, hair, scales, feathers, skin, plates, spines, horns, antlers, beak, shell, or exoskeleton. Map surface texture and color distribution including blocking, stripes, spots, ticking, brindle, patches, gradients, and species-specific markings. Then probability-match those combined markers against biological taxonomy, weighing likely species, genus/type, breed or variety. State the closest supported classification, confidence, evidence, and alternatives; never let scenery or photographic style decide the animal.

For every person, describe visible identity features without naming or trying to recognize the individual and without matching against a face-recognition database. Map facial landmarks including eye corners and spacing, nose shape, mouth shape, jaw contour, cheek structure, and face shape. Preserve the relative proportions and angles among the forehead, eyes, nose, mouth, jaw, and lower face. Map visible skin tone, hair color/texture/style, eye color, facial hair, eyewear, and distinguishing non-sensitive visible features. Beyond the face, inspect silhouette, apparent age group, body proportions and build, posture, clothing, and accessories. Use breedConfidence=not_applicable. If a face, tail, ear, eye, limb, marking, garment, or accessory is obscured, put that fact in uncertainDetails instead of inventing it. Never substitute a stereotypical breed, age, skin tone, color, body type, or face.

When the upload contains multiple principal people or animals, create one subjects entry for every principal subject in stable left-to-right order. Give each a referencePosition and its own species/type, breed guess, confidence, markers, exact identity description, and uncertainties. Never average, merge, hybridize, or transfer the coat, face, ears, tail, body, clothing, or accessories of one subject onto another. subjectCount must equal subjects.length.`},{role:'user',content:[{type:'text',text:'Create the exact visual identity lock for every principal subject in this uploaded reference.'},{type:'image_url',image_url:{url:dataUrl}}]}]
    })
  });
  const payload=await response.json();
  if(!response.ok)throw new Error(payload?.error?.message||'Reference identity analysis failed');
  let parsed;
  try{parsed=JSON.parse(String(payload?.choices?.[0]?.message?.content||''))}catch{throw new Error('Reference identity analysis returned invalid JSON')}
  const description=String(parsed?.identityDescription||'').trim();
  if(description.length<40)throw new Error('Reference identity analysis was incomplete');
  const uncertain=Array.isArray(parsed?.uncertainDetails)?parsed.uncertainDetails.map(value=>String(value).trim()).filter(Boolean):[];
  const subjects=(Array.isArray(parsed?.subjects)?parsed.subjects:[]).map((subject,index)=>({
    referencePosition:String(subject?.referencePosition||`subject ${index+1}`).trim(),
    kind:String(subject?.kind||'animal').trim(),
    species:String(subject?.species||'').trim(),
    primaryBreedGuess:String(subject?.primaryBreedGuess||'').trim(),
    breedConfidence:String(subject?.breedConfidence||'low'),
    keyMarkers:Array.isArray(subject?.keyMarkers)?subject.keyMarkers.map(value=>String(value).trim()).filter(Boolean):[],
    identityDescription:String(subject?.identityDescription||'').trim(),
    uncertainDetails:Array.isArray(subject?.uncertainDetails)?subject.uncertainDetails.map(value=>String(value).trim()).filter(Boolean):[]
  })).filter(subject=>subject.identityDescription.length>=20);
  if(!subjects.length||subjects.length!==Number(parsed.subjectCount||0))throw new Error('Reference identity analysis did not separate every subject');
  return{
    subjectCount:Number(parsed.subjectCount||1),
    subjectType:String(parsed.subjectType||'pet'),
    species:String(parsed.species||'').trim(),
    primaryBreedGuess:String(parsed.primaryBreedGuess||'').trim(),
    breedConfidence:String(parsed.breedConfidence||'low'),
    keyMarkers:Array.isArray(parsed.keyMarkers)?parsed.keyMarkers.map(value=>String(value).trim()).filter(Boolean):[],
    breedAlternatives:Array.isArray(parsed.breedAlternatives)?parsed.breedAlternatives.map(value=>String(value).trim()).filter(Boolean):[],
    identityDescription:description,
    uncertainDetails:uncertain,
    subjects
  };
}

function lockScreenplayIdentity(screenplay,identity){
  const summaries=identity.subjects.map((subject,index)=>`S${index+1} ${subject.referencePosition}: ${subject.species} ${subject.primaryBreedGuess}; ${subject.keyMarkers.slice(0,4).join(', ')}`).join(' | ');
  const details=identity.subjects.map((subject,index)=>`S${index+1} exact identity: ${subject.identityDescription}${subject.uncertainDetails.length?`; obscured, do not invent: ${subject.uncertainDetails.join(', ')}`:''}`).join(' ');
  const lock=`PHOTO-DERIVED SUBJECT LOCKS (${identity.subjects.length}): ${summaries}. ${details} Keep every subject separate and recognizable; never merge, hybridize, swap or average their anatomy, facial geometry, colors, markings, hair/fur, ears, tails, clothing or accessories. STYLE: warm stylized 3D CGI animated-movie rendering with rounded digital-sculpture forms, clear weight and volume, appealing simplified facial proportions, tactile hair, fur and fabric, soft environmental light, gentle highlights and shallow cinematic depth. Define curved form through light and shadow, never hard outlines. Neither photoreal/live-action nor flat 2D/vector cartoon.`;
  return{...screenplay,scenes:screenplay.scenes.map(scene=>({...scene,identityLock:`${lock} ${String(scene.identityLock||'')}`.trim()}))};
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'RunPod configuration incomplete'});
  const editedStory=String(req.body?.plan||'').trim();
  if(!editedStory||!req.body?.image)return res.status(400).json({error:'Story plan and photo are required'});
  const mcsJobId=crypto.randomUUID();
  const callbackBase='https://main-character-studios.vercel.app';
  try{
    const comma=req.body.image.indexOf(',');
    if(comma<0)throw new Error('Photo format is invalid');
    const meta=req.body.image.slice(0,comma);
    const image=Buffer.from(req.body.image.slice(comma+1),'base64');
    if(!image.length)throw new Error('Photo is empty');
    const imageType=(meta.match(/^data:([^;]+)/)||[])[1]||'image/jpeg';
    const dataUrl=`data:${imageType};base64,${req.body.image.slice(comma+1)}`;
    const[compiled,subjectIdentity]=await Promise.all([
      compileStoryScreenplay(editedStory,req.body?.moods||[]),
      analyzeReference(dataUrl)
    ]);
    const screenplay=lockScreenplayIdentity(compiled,subjectIdentity);
    await store(mcsJobId,'reference',image,imageType);
    await store(mcsJobId,'story-plan',Buffer.from(JSON.stringify({plan:editedStory,screenplay,subjectIdentity})),'application/json');
    const r=await fetch(base+'/run',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({input:{
        jobId:mcsJobId,
        callbackBase,
        mode:'preview',
        workerSecret:process.env.MCS_WORKER_SECRET||'',
        duration_seconds:60,
        preview_scene_count:6,
        total_scene_count:18,
        full_duration_seconds:180
      }})
    });
    const j=await r.json();
    if(!r.ok)throw new Error(j?.error||j?.message||'RunPod rejected preview');
    return res.status(200).json({ok:true,mcsJobId,jobId:j.id,status:j.status});
  }catch(e){
    return res.status(502).json({error:e.message});
  }
}
