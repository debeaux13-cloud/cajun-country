import crypto from 'crypto';
import{put}from'@vercel/blob';
import{getVercelOidcToken}from'@vercel/oidc';
import{runpod}from'./_runpod';
import{submitPreviewJob}from'../../lib/preview-worker-orchestrator';
import{compileStoryScreenplay}from'./_story-screenplay';
import{MAX_REFERENCE_SUBJECTS,normalizeSubjects}from'../../lib/subject-contract';
import{previewRequestIdFromEntitlement,verifyPhotoPreviewEntitlement}from'../../lib/photo-entitlement';
import{classifyPreviewClaim,enforceOfficialPreviewOrigin,enforcePreviewRateLimit,getPreviewClaim,previewClaimResponse,previewRequestHash,reservePreviewClaim,retryFailedPreviewClaim,updatePreviewClaim}from'../../lib/preview-guard';

export const config={api:{bodyParser:{sizeLimit:'15mb'}}};

const STORY_VIBES=new Set(['surprise me','funny','magical','adventure','heartwarming','mystery','kid-safe spooky']);
const PHOTO_RETRY_ISSUES=new Set(['severe_blur','near_black','blown_out','subject_too_small','subject_mostly_hidden','corrupted_or_unreadable','ui_obstruction','no_principal_subject']);
function normalizeMoods(value){const items=Array.isArray(value)?value:[value];const moods=items.map(item=>String(item||'').trim().toLowerCase()).filter(item=>STORY_VIBES.has(item));return[moods[0]||'surprise me']}

function hasImageSignature(buffer,mime){
  if(mime==='image/jpeg')return buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(mime==='image/png')return buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(mime==='image/webp')return buffer.length>=12&&buffer.subarray(0,4).toString('ascii')==='RIFF'&&buffer.subarray(8,12).toString('ascii')==='WEBP';
  return false;
}

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
    subjectId:{type:'string',pattern:'^S(?:[1-9]|1[0-2])$'},
    referencePosition:{type:'string'},
    kind:{type:'string',enum:['person','dog','cat','animal']},
    apparentAgeGroup:{type:'string',enum:['baby','toddler','child','teen','adult','older_adult','not_applicable']},
    species:{type:'string'},
    primaryBreedGuess:{type:'string'},
    breedConfidence:{type:'string',enum:['high','medium','low','not_applicable']},
    keyMarkers:{type:'array',items:{type:'string'}},
    identityDescription:{type:'string'},
    uncertainDetails:{type:'array',items:{type:'string'}}
  },
  required:['subjectId','referencePosition','kind','apparentAgeGroup','species','primaryBreedGuess','breedConfidence','keyMarkers','identityDescription','uncertainDetails']
};

const identitySchema={
  type:'object',additionalProperties:false,
  properties:{
    photoUsabilityStatus:{type:'string',enum:['good','caution','retry_required']},
    photoBlockingIssue:{type:'string',enum:['none',...PHOTO_RETRY_ISSUES]},
    photoUsabilityReason:{type:'string'},
    subjectCount:{type:'integer',minimum:0,maximum:MAX_REFERENCE_SUBJECTS},
    subjectType:{type:'string',enum:['person','pet','people','pets','person_and_pet','mixed']},
    species:{type:'string'},
    primaryBreedGuess:{type:'string'},
    breedConfidence:{type:'string',enum:['high','medium','low','not_applicable']},
    keyMarkers:{type:'array',items:{type:'string'}},
    breedAlternatives:{type:'array',items:{type:'string'}},
    identityDescription:{type:'string'},
    uncertainDetails:{type:'array',items:{type:'string'}},
    subjects:{type:'array',minItems:0,maxItems:MAX_REFERENCE_SUBJECTS,items:subjectSchema}
  },
  required:['photoUsabilityStatus','photoBlockingIssue','photoUsabilityReason','subjectCount','subjectType','species','primaryBreedGuess','breedConfidence','keyMarkers','breedAlternatives','identityDescription','uncertainDetails','subjects']
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

For every person, describe visible identity features without naming or trying to recognize the individual and without matching against a face-recognition database. Map facial landmarks including eye corners and spacing, nose shape, mouth shape, jaw contour, cheek structure, and face shape. Preserve the relative proportions and angles among the forehead, eyes, nose, mouth, jaw, and lower face. Map visible skin tone, hair color/texture/style, eye color, facial hair, eyewear, and distinguishing non-sensitive visible features. Beyond the face, inspect silhouette, body proportions and build, posture, clothing, and accessories. Classify apparentAgeGroup as baby, toddler, child, teen, adult, or older_adult using only visible developmental evidence; never infer a precise age, and record genuine ambiguity in uncertainDetails. Use apparentAgeGroup=not_applicable for every animal and breedConfidence=not_applicable for every person. If a face, tail, ear, eye, limb, marking, garment, or accessory is obscured, put that fact in uncertainDetails instead of inventing it. Never substitute a stereotypical breed, age, skin tone, color, body type, or face.

Also make a forgiving final photo-usability decision before production. Everyday phone photos, screenshots of photos, spontaneous child or pet pictures, imperfect lighting, ordinary cropping, busy backgrounds, mild blur, filters, non-front-facing poses, missing full bodies, and lack of eye contact are acceptable. Use caution while still allowing production when moderate imperfections may reduce likeness. Use retry_required only when reliable identity is genuinely impossible because of one allowed photoBlockingIssue: severe blur, near-black exposure, blown-out exposure, every subject being too tiny, a principal subject being mostly hidden, corrupted/unreadable image, UI covering defining features, or no principal living subject. When uncertain between caution and retry_required, choose caution. Studio-quality photography is never required.

Inventory every visible living person and animal in the uploaded group photo, including family members, pets, and partially obscured subjects. Exclude only images on screens or paper, reflections, statues, and toys. Support up to ${MAX_REFERENCE_SUBJECTS} visible subjects. Create one subjects entry per subject in stable left-to-right order, assign exact sequential IDs S1, S2, S3 and so on, and describe each independently. If two subjects look similar, use position plus their smallest visible differences to keep them distinct. Never average, merge, hybridize, swap, duplicate, omit, or transfer the coat, face, ears, tail, body, clothing, markings, or accessories of one subject onto another. subjectCount must equal subjects.length and each subjectId must match its array position.`},{role:'user',content:[{type:'text',text:'Create a separate, exact visual identity lock for every visible person and animal in this uploaded reference.'},{type:'image_url',image_url:{url:dataUrl}}]}]
    })
  });
  const payload=await response.json();
  if(!response.ok)throw new Error(payload?.error?.message||'Reference identity analysis failed');
  let parsed;
  try{parsed=JSON.parse(String(payload?.choices?.[0]?.message?.content||''))}catch{throw new Error('Reference identity analysis returned invalid JSON')}
  let photoUsabilityStatus=['good','caution','retry_required'].includes(parsed?.photoUsabilityStatus)?parsed.photoUsabilityStatus:'caution';
  const photoBlockingIssue=String(parsed?.photoBlockingIssue||'none');
  if(photoUsabilityStatus==='retry_required'&&!PHOTO_RETRY_ISSUES.has(photoBlockingIssue))photoUsabilityStatus='caution';
  if(photoUsabilityStatus==='retry_required'){
    const reason=String(parsed?.photoUsabilityReason||'The main subject is not clear enough to preserve reliably.').replace(/\s+/g,' ').trim().slice(0,220);
    throw new Error(`Photo retry required: ${reason} Please choose a clearer photo; casual phone pictures and screenshots are welcome.`);
  }
  const description=String(parsed?.identityDescription||'').trim();
  const uncertain=Array.isArray(parsed?.uncertainDetails)?parsed.uncertainDetails.map(value=>String(value).trim()).filter(Boolean):[];
  const subjects=normalizeSubjects({subjects:(Array.isArray(parsed?.subjects)?parsed.subjects:[]).map((subject,index)=>{
    const kind=String(subject?.kind||'animal').trim();
    return{
      subjectId:`S${index+1}`,
      referencePosition:String(subject?.referencePosition||`subject ${index+1}`).trim(),
      kind,
      apparentAgeGroup:kind==='person'?String(subject?.apparentAgeGroup||'not_applicable').trim():'not_applicable',
      species:String(subject?.species||'').trim(),
      primaryBreedGuess:String(subject?.primaryBreedGuess||'').trim(),
      breedConfidence:String(subject?.breedConfidence||'low'),
      keyMarkers:Array.isArray(subject?.keyMarkers)?subject.keyMarkers.map(value=>String(value).trim()).filter(Boolean):[],
      identityDescription:String(subject?.identityDescription||'').trim(),
      uncertainDetails:Array.isArray(subject?.uncertainDetails)?subject.uncertainDetails.map(value=>String(value).trim()).filter(Boolean):[]
    };
  })}).filter(subject=>subject.identityDescription.length>=20);
  if(!subjects.length||subjects.length!==Number(parsed.subjectCount||0))throw new Error('Reference identity analysis did not separate every subject');
  const identityDescription=description.length>=40
    ?description
    :subjects.map(subject=>`${subject.subjectId} ${subject.referencePosition}: ${subject.identityDescription}`).join(' | ');
  if(identityDescription.length<40)throw new Error('Reference identity analysis was incomplete');
  return{
    subjectCount:Number(parsed.subjectCount||1),
    subjectType:String(parsed.subjectType||'pet'),
    species:String(parsed.species||'').trim(),
    primaryBreedGuess:String(parsed.primaryBreedGuess||'').trim(),
    breedConfidence:String(parsed.breedConfidence||'low'),
    keyMarkers:Array.isArray(parsed.keyMarkers)?parsed.keyMarkers.map(value=>String(value).trim()).filter(Boolean):[],
    breedAlternatives:Array.isArray(parsed.breedAlternatives)?parsed.breedAlternatives.map(value=>String(value).trim()).filter(Boolean):[],
    identityDescription,
    uncertainDetails:uncertain,
    subjects
  };
}

const SCENE_IDENTITY_LOCK_LIMIT=500;

function compactWords(value,limit){
  const text=String(value||'').replace(/\s+/g,' ').trim();
  if(text.length<=limit)return text;
  return text.slice(0,limit).replace(/\s+\S*$/,'').trim()||text.slice(0,limit);
}

function phraseAppears(text,value){
  const normalize=input=>String(input||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const phrase=normalize(value);
  return Boolean(phrase)&&` ${normalize(text)} `.includes(` ${phrase} `);
}

function sceneSubjectIds(scene,subjects,bindings){
  const allowed=new Set(subjects.map(subject=>subject.subjectId));
  const ids=new Set();
  const characters=Array.isArray(scene?.characters)?scene.characters.map(value=>String(value||'')):[];
  for(const entry of characters){
    for(const subjectId of entry.match(/\bS(?:[1-9]|1[0-2])\b/gi)||[]){
      const normalized=subjectId.toUpperCase();
      if(allowed.has(normalized))ids.add(normalized);
    }
  }
  for(const binding of bindings){
    const subjectId=String(binding?.productionSubjectId||'').toUpperCase();
    if(!allowed.has(subjectId))continue;
    if(characters.some(entry=>phraseAppears(entry,binding?.storyIdentity)))ids.add(subjectId);
  }
  return subjects.filter(subject=>ids.has(subject.subjectId));
}

function evenlyBudgetedSubjectDetails(subjects,storyIdentityById,totalBudget){
  if(!subjects.length)return'none';
  const separators=Math.max(0,subjects.length-1)*3;
  const available=Math.max(subjects.reduce((sum,subject)=>sum+subject.subjectId.length+1,0),totalBudget-separators);
  const base=Math.floor(available/subjects.length);
  let remainder=available-(base*subjects.length);
  return subjects.map(subject=>{
    const budget=base+(remainder>0?1:0);
    if(remainder>0)remainder--;
    const identity=compactWords(storyIdentityById.get(subject.subjectId)||'',16);
    const type=subject.kind==='person'
      ?`${String(subject.apparentAgeGroup||'person').replace('_',' ')} person`
      :[subject.primaryBreedGuess,subject.species||subject.kind||'animal'].filter(Boolean).join(' ');
    const exact=[subject.referencePosition,type,subject.keyMarkers.join(', '),subject.identityDescription,subject.uncertainDetails.length?`obscured—do not invent ${subject.uncertainDetails.join(', ')}`:''].filter(Boolean).join('; ');
    const prefix=`${subject.subjectId}=${identity?`${identity}/`:''}`;
    return`${prefix}${compactWords(exact,Math.max(0,budget-prefix.length))}`.slice(0,budget).trim();
  }).join(' | ');
}

export function lockScreenplayIdentity(screenplay,identity){
  const subjects=normalizeSubjects(identity);
  const bindings=Array.isArray(screenplay?.sourceCoverage?.characterBindings)?screenplay.sourceCoverage.characterBindings:[];
  const primaryBindings=bindings.filter(binding=>!binding?.isExplicitSourceAlias&&/^S(?:[1-9]|1[0-2])$/i.test(String(binding?.productionSubjectId||'')));
  const storyIdentityById=new Map(primaryBindings.map(binding=>[String(binding.productionSubjectId).toUpperCase(),String(binding.storyIdentity||binding.role||'').trim()]));
  return{...screenplay,scenes:screenplay.scenes.map(scene=>{
    const present=sceneSubjectIds(scene,subjects,bindings);
    const prefix=`PHOTO SCENE IDS (${present.length}/${subjects.length}): `;
    const suffix=present.length
      ?'. Only these upload IDs appear; others stay off-screen. Keep IDs exact/distinct. No merge, swap, hybrid, duplicate, or trait transfer. Preserve listed age/species, anatomy, face/build, colors/markings, hair/fur, ears/tail, clothes/accessories.'
      :'. Show no uploaded subject in this scene; use only screenplay-listed supporting characters.';
    const details=evenlyBudgetedSubjectDetails(present,storyIdentityById,Math.max(0,SCENE_IDENTITY_LOCK_LIMIT-prefix.length-suffix.length));
    const identityLock=`${prefix}${details}${suffix}`;
    if(identityLock.length>SCENE_IDENTITY_LOCK_LIMIT)throw new Error(`Scene ${scene.sceneNumber} identity lock exceeds its production budget`);
    return{...scene,referenceSubjectIds:present.map(subject=>subject.subjectId),identityLock};
  })};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const blobToken=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(req.method==='GET'){
    if(!blobToken)return res.status(503).json({error:'Preview storage is unavailable'});
    try{
      const requestId=previewRequestIdFromEntitlement(req.query?.entitlement);
      const claim=await getPreviewClaim(requestId,blobToken);
      if(!claim)return res.status(404).json({error:'Preview request not found'});
      if(claim.status==='submitted'&&claim.jobId&&claim.mcsJobId)return res.status(200).json(previewClaimResponse(claim));
      if(claim.status==='submitting')return res.status(202).json({ok:true,pending:true,mcsJobId:claim.mcsJobId||'',status:'SUBMITTING'});
      if(claim.status==='submission_unknown')return res.status(409).json({error:'This preview may already be running, but its provider receipt was interrupted. Contact support before trying again so no duplicate render is charged.',mcsJobId:claim.mcsJobId||''});
      return res.status(409).json({error:'This preview request was not accepted. Contact support before retrying.',mcsJobId:claim.mcsJobId||''});
    }catch(error){
      return res.status(/valid preview request/i.test(String(error?.message||''))?400:502).json({error:error.message});
    }
  }
  if(req.method!=='POST')return res.status(405).json({error:'GET or POST only'});
  if(!blobToken)return res.status(503).json({error:'Preview storage is unavailable'});
  try{enforceOfficialPreviewOrigin(req)}catch(error){return res.status(403).json({error:error.message})}
  const{key,base}=runpod();
  if(!key||!base)return res.status(503).json({error:'RunPod configuration incomplete'});
  if(process.env.VERCEL_ENV==='preview'&&(!process.env.MCS_WORKER_SECRET||!process.env.BLOB_READ_WRITE_TOKEN||!process.env.VERCEL_URL))return res.status(503).json({error:'Preview worker configuration incomplete'});
  const editedStory=String(req.body?.plan||'').trim();
  const creativeMode=req.body?.creativeMode==='make_for_me'?'make_for_me':'my_story';
  const originalIdea=typeof req.body?.originalIdea==='string'?req.body.originalIdea.trim():editedStory;
  const storyBrief=req.body?.storyBrief??originalIdea;
  const sourceLedger=req.body?.sourceLedger&&typeof req.body.sourceLedger==='object'?req.body.sourceLedger:null;
  const moods=normalizeMoods(req.body?.moods);
  if(!editedStory||!req.body?.image)return res.status(400).json({error:'Story plan and photo are required'});
  let requestId;
  try{requestId=verifyPhotoPreviewEntitlement(req.body?.previewEntitlement,req.body.image)}catch(error){return res.status(400).json({error:error.message})}
  const requestHash=previewRequestHash({creativeMode,originalIdea,storyBrief,sourceLedger,plan:editedStory,image:req.body.image,moods});
  const mcsJobId=crypto.randomUUID();
  const callbackBase='https://main-character-studios.vercel.app';
  try{
    await enforcePreviewRateLimit(req,requestId,blobToken,3);
    let retryClaim=null;
    const existingClaim=await getPreviewClaim(requestId,blobToken);
    if(existingClaim){
      try{
        const existing=classifyPreviewClaim(existingClaim,requestHash);
        if(existing.state==='submitted')return res.status(200).json({...previewClaimResponse(existing.claim),duplicate:true});
        if(existing.state==='pending')return res.status(202).json({ok:true,pending:true,mcsJobId:existing.claim.mcsJobId||'',status:'SUBMITTING'});
      }catch(error){
        if(process.env.VERCEL_ENV!=='preview'||!existingClaim.jobId)throw error;
        const prior=await fetch(base+'/status/'+encodeURIComponent(existingClaim.jobId),{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});
        const priorPayload=await prior.json().catch(()=>({}));
        const priorStatus=String(priorPayload?.status||'').toUpperCase();
        if(!prior.ok||!['FAILED','CANCELLED','TIMED_OUT'].includes(priorStatus))throw error;
        retryClaim=existingClaim;
      }
    }
    const match=String(req.body.image).match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if(!match)throw new Error('Photo must be a JPEG, PNG, or WebP image');
    const encoded=match[2].replace(/\s+/g,'');
    const image=Buffer.from(encoded,'base64');
    if(!image.length)throw new Error('Photo is empty');
    if(image.length>4*1024*1024)throw new Error('Prepared photo is larger than 4 MB');
    const imageType=match[1].toLowerCase().replace('image/jpg','image/jpeg');
    if(image.toString('base64')!==encoded||!hasImageSignature(image,imageType))throw new Error('Photo file looks damaged or unreadable');
    const dataUrl=`data:${imageType};base64,${encoded}`;
    const subjectIdentity=await analyzeReference(dataUrl);
    const compiled=await compileStoryScreenplay(editedStory,moods,{
      creativeMode,
      originalIdea,
      sourceLedger,
      subjectRoster:normalizeSubjects(subjectIdentity)
    });
    const screenplay=lockScreenplayIdentity(compiled,subjectIdentity);
    await store(mcsJobId,'reference',image,imageType);
    await store(mcsJobId,'story-plan',Buffer.from(JSON.stringify({creativeMode,storyBrief,sourceLedger,originalIdea,plan:editedStory,moods,selectedVibe:moods[0],screenplay,subjectIdentity})),'application/json');
    const reservation=retryClaim
      ?await retryFailedPreviewClaim({id:requestId,claim:retryClaim,requestHash,mcsJobId,token:blobToken})
      :await reservePreviewClaim({id:requestId,requestHash,mcsJobId,token:blobToken});
    if(reservation.state==='submitted')return res.status(200).json({...previewClaimResponse(reservation.claim),duplicate:true});
    if(reservation.state==='pending')return res.status(202).json({ok:true,pending:true,mcsJobId:reservation.claim.mcsJobId||'',status:'SUBMITTING'});
    let dispatched;
    try{
      if(process.env.VERCEL_ENV==='preview'){
        dispatched=await submitPreviewJob({id:mcsJobId,idempotencyKey:requestHash});
      }else{
        const response=await fetch(base+'/run',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({input:{jobId:mcsJobId,callbackBase:'https://main-character-studios.vercel.app',mode:'preview',workerSecret:process.env.MCS_WORKER_SECRET||'',duration_seconds:60,preview_scene_count:6,total_scene_count:18,full_duration_seconds:180}})});
        const payload=await response.json().catch(()=>({}));
        if(!response.ok||!payload?.id)throw new Error(payload?.error||payload?.message||'RunPod rejected preview');
        dispatched={runpodJobId:String(payload.id),runpodStatus:String(payload.status||'')};
      }
    }catch(error){
      await updatePreviewClaim(requestId,reservation.claim,blobToken,'submission_unknown',{error:String(error?.message||error).slice(0,300)});
      throw new Error('RunPod receipt was interrupted; this request is locked to prevent a duplicate render. Contact support before retrying.');
    }
    const jobId=String(dispatched.runpodJobId||'').trim();
    if(!jobId)throw new Error('RunPod returned no job ID; this request is locked to prevent a duplicate render. Contact support before retrying.');
    const submitted=await updatePreviewClaim(requestId,reservation.claim,blobToken,'submitted',{jobId,runpodStatus:String(dispatched.runpodStatus||'')});
    return res.status(200).json(previewClaimResponse(submitted));
  }catch(e){
    const message=String(e?.message||e);
    const status=/daily safety limit/i.test(message)?429:/already|may already|locked|before retrying|before trying again/i.test(message)?409:/Photo|story|preview request/i.test(message)?400:502;
    return res.status(status).json({error:message});
  }
}
