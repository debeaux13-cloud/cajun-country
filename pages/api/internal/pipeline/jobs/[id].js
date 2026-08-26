import{BlobNotFoundError,head,put}from'@vercel/blob';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_PHASES=['image','animation'];

function auth(req){
  const secret=process.env.MCS_WORKER_SECRET||'';
  const header=req.headers.authorization||'';
  return!!secret&&(header==='Bearer '+secret||header===secret)
}

function validJobId(id){return UUID.test(String(id||''))}

async function readPrivateJson(pathname,token){
  const meta=await head(pathname,{token});
  const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error(`Private Blob fetch failed ${response.status}`);
  return response.json()
}

async function loadStagePlan(id){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Blob storage missing');
  const saved=await readPrivateJson(`mcs/jobs/${id}/story-plan.bin`,token);
  return String(saved.plan||'').trim()
}

function storyScenes(plan){
  let lines=String(plan||'').split(/\n+/).map(x=>x.trim()).filter(Boolean).map(x=>x.replace(/^\s*\d+[.)-]?\s*/,''));
  if(lines.length<18)lines=String(plan||'').split(/(?<=[.!?])\s+/).map(x=>x.trim()).filter(Boolean);
  if(lines.length<18)throw new Error(`Stage plan contains ${lines.length} usable scenes; expected 18`);
  return lines.slice(0,18).map((text,index)=>{
    const sceneNumber=index+1;
    return{
      sceneNumber,
      text,
      description:text,
      characters:['Main Character'],
      setting:`Story scene ${sceneNumber}: ${text.slice(0,140)}`,
      emotionalTone:sceneNumber<=6?'building attachment':sceneNumber<15?'adventurous':'emotional payoff',
      keyActionVerbs:['moves','reacts','interacts','advances'],
      narration:text,
      visibleAction:`The main character visibly performs exactly this story beat: ${text}`,
      requiredVisibleDetails:['preserve exact reference identity','show every narrated object/action','continuous purposeful character motion','cinematic animated-feature style, not photoreal and not flat kid-cartoon'],
      motionBeats:['0-3 seconds: begin the narrated action immediately','3-7 seconds: travel, react, and interact through this exact story beat','7-10 seconds: visibly complete this narrated beat and set up the next scene'],
      emotionalIntensity:Math.min(10,4+Math.ceil(sceneNumber/3)),
      actionDensity:8,
      staticLevel:0,
      petPresent:true,
      hero_scene:true,
      pet_present:true,
      animationProvider:'runway-gen4-turbo'
    }
  })
}

function checkpointPath(id,phase,scene){
  return`mcs/jobs/${id}/provider-tasks/${phase}-scene-${scene}.json`
}

async function loadProviderJobs(id){
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Blob storage missing');
  const records=await Promise.all(
    Array.from({length:12},(_,index)=>index+7).flatMap(scene=>
      PROVIDER_PHASES.map(async phase=>{
        try{return await readPrivateJson(checkpointPath(id,phase,scene),token)}
        catch(error){
          if(error instanceof BlobNotFoundError)return null;
          throw error
        }
      })
    )
  );
  const jobs={};
  for(const record of records.filter(Boolean)){
    const scene=Number(record.sceneNumber);
    const taskId=String(record.providerJobId||'');
    if(scene<7||scene>18||!UUID.test(taskId)||record.status==='provider_failed')continue;
    const entry=jobs[String(scene)]||(jobs[String(scene)]={});
    if(record.phase==='image'){
      entry.imageProviderJobId=taskId;
      entry.imageProvider=String(record.provider||'');
      entry.imageStatus=String(record.status||'');
    }
    if(record.phase==='animation'){
      entry.animationProviderJobId=taskId;
      entry.animationProvider=String(record.provider||'');
      entry.animationStatus=String(record.status||'');
      entry.providerJobId=taskId;
    }
  }
  return jobs
}

async function persistProviderCheckpoint(id,body){
  const scene=Number(body?.scene);
  const stage=String(body?.stage||'');
  const status=String(body?.status||'');
  const providerJobId=String(body?.providerJobId||'').trim();
  if(!providerJobId)return false;
  if(providerJobId==='motion-quality-rerender')return false;
  if(scene<7||scene>18)return false;
  const phase=stage==='illustrating'?'image':stage==='animating'?'animation':'';
  if(!phase)return false;
  if(!['provider_started','provider_failed','illustrated','animated'].includes(status))return false;
  if(!UUID.test(providerJobId))throw new Error('Invalid provider task checkpoint');
  const provider=String(body?.provider||'');
  if(phase==='image'&&provider!=='runway-gen4-image-turbo')throw new Error('Invalid image provider checkpoint');
  if(phase==='animation'&&!['runway-gen4-turbo','runway-gen4-turbo-motion-retry'].includes(provider))throw new Error('Invalid animation provider checkpoint');
  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)throw new Error('Blob storage missing');
  const record={
    version:1,
    sceneNumber:scene,
    phase,
    provider,
    providerJobId,
    status,
    retryAttempt:Number(body?.retryAttempt||0),
    priorProviderJobId:UUID.test(String(body?.priorProviderJobId||''))?String(body.priorProviderJobId):'',
    updatedAt:new Date().toISOString()
  };
  await put(checkpointPath(id,phase,scene),JSON.stringify(record),{
    access:'private',
    addRandomSuffix:false,
    allowOverwrite:true,
    contentType:'application/json',
    token
  });
  return true
}

async function contract(id){
  const base='https://main-character-studios.vercel.app/api/internal/pipeline/jobs/'+id;
  const runway=process.env.Runway||process.env.RUNWAY_API_KEY||'';
  const eleven=process.env.ELEVENLABS_API_KEY||process.env.Elevenlabs_Secured_key||process.env.Elevenlabs_Secured_key_2||'';
  const[plan,existingProviderJobs]=await Promise.all([loadStagePlan(id),loadProviderJobs(id)]);
  const scenes=storyScenes(plan);
  return{
    id,
    orderId:id,
    tier:'standard_hybrid',
    vision:plan,
    approvedPreview:{
      title:'Main Character Studios Preview',
      page_title:'The story begins',
      story_text:plan,
      scene_prompt:plan,
      organized_story:plan,
      original_customer_input:plan,
      selected_topic:'',
      featured_names:['Main Character'],
      subject_kind:'pet_or_mixed',
      character_traits:{subject_count:1,subject_type:'pet_or_person',species:'unknown',breed:'unknown',traits:[],hard_constraints:[],ambiguity_notes:[],customer_notes:''},
      character_notes:''
    },
    ownerQa:false,
    retryLimitHit:0,
    resumeStoredAssets:true,
    reusableOwnerSceneNumbers:[1,2,3,4,5,6],
    reusableOwnerVideoSceneNumbers:[1,2,3,4,5,6],
    existingProviderJobs,
    existingManifest:{
      version:3,
      tier:'three_minute',
      title:'Main Character Studios Movie',
      subtitle:'Three-minute personalized moving story',
      pages:scenes.map(scene=>({sceneNumber:scene.sceneNumber,text:scene.text})),
      scenes
    },
    assets:{
      reference:base+'/asset?kind=reference',
      approvedScene:base+'/asset?kind=approved-scene',
      previewScene:base+'/asset',
      upload:base+'/asset',
      illustrate:base+'/illustrate'
    },
    callback:base,
    rankManifest:base+'/rank',
    providers:{
      openaiApiKey:'',
      runwayApiKey:runway,
      elevenLabsApiKey:eleven,
      elevenLabsVoiceId:process.env.ELEVENLABS_VOICE_ID||'21m00Tcm4TlvDq8ikWAM',
      elevenLabsModelId:process.env.ELEVENLABS_MODEL_ID||'eleven_flash_v2_5'
    },
    contract:{
      scenes:18,
      previewScenes:6,
      secondsPerScene:10,
      previewSeconds:60,
      movieSeconds:180,
      heroScenes:18,
      heroScoring:false,
      motion:'runway-gen4-turbo-all-scenes',
      petMode:true,
      petRouting:'runway-gen4-turbo-only',
      animalPoseDetection:false
    }
  }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(!auth(req))return res.status(401).send('Unauthorized');
  const id=String(req.query?.id||'');
  if(!validJobId(id))return res.status(400).json({error:'Invalid job id'});
  if(req.method==='GET'){
    try{return res.status(200).json(await contract(id))}
    catch(error){return res.status(500).json({error:error.message})}
  }
  if(req.method==='PATCH'){
    try{
      const checkpointed=await persistProviderCheckpoint(id,req.body||{});
      return res.status(200).json({ok:true,id,checkpointed})
    }catch(error){
      return res.status(503).json({error:error.message})
    }
  }
  return res.status(405).json({error:'Method not allowed'})
}
