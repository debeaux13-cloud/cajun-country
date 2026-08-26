import{BlobNotFoundError,head,put}from'@vercel/blob';
import{subjectContract}from'../../../../../lib/subject-contract';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_PHASES=['image','animation'];

function auth(req){const secret=process.env.MCS_WORKER_SECRET||'';const header=req.headers.authorization||'';return!!secret&&(header==='Bearer '+secret||header===secret)}
function validJobId(id){return UUID.test(String(id||''))}
async function readPrivateJson(pathname,token){const meta=await head(pathname,{token});const response=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error(`Private Blob fetch failed ${response.status}`);return response.json()}
async function loadStageData(id){const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)throw new Error('Blob storage missing');const saved=await readPrivateJson(`mcs/jobs/${id}/story-plan.bin`,token);if(!Array.isArray(saved?.screenplay?.scenes)||saved.screenplay.scenes.length!==18)throw new Error('Structured 18-scene screenplay missing');return saved}
function storyScenes(saved){return saved.screenplay.scenes.map((scene,index)=>({...scene,sceneNumber:index+1,staticLevel:0,hero_scene:true,animationProvider:'runway-gen4-turbo',requiredVisibleDetails:[...(scene.requiredVisibleDetails||[]),scene.identityLock||'Preserve exact uploaded identity and anatomy.']}))}
function checkpointPath(id,phase,scene){return`mcs/jobs/${id}/provider-tasks/${phase}-scene-${scene}.json`}
async function loadProviderJobs(id){const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)throw new Error('Blob storage missing');const records=await Promise.all(Array.from({length:12},(_,index)=>index+7).flatMap(scene=>PROVIDER_PHASES.map(async phase=>{try{return await readPrivateJson(checkpointPath(id,phase,scene),token)}catch(error){if(error instanceof BlobNotFoundError)return null;throw error}})));const jobs={};for(const record of records.filter(Boolean)){const scene=Number(record.sceneNumber);const taskId=String(record.providerJobId||'');if(scene<7||scene>18||!UUID.test(taskId)||record.status==='provider_failed')continue;const entry=jobs[String(scene)]||(jobs[String(scene)]={});if(record.phase==='image'){entry.imageProviderJobId=taskId;entry.imageProvider=String(record.provider||'');entry.imageStatus=String(record.status||'')}if(record.phase==='animation'){entry.animationProviderJobId=taskId;entry.animationProvider=String(record.provider||'');entry.animationStatus=String(record.status||'');entry.providerJobId=taskId}}return jobs}
async function persistProviderCheckpoint(id,body){const scene=Number(body?.scene);const stage=String(body?.stage||'');const status=String(body?.status||'');const providerJobId=String(body?.providerJobId||'').trim();if(!providerJobId||providerJobId==='motion-quality-rerender'||scene<7||scene>18)return false;const phase=stage==='illustrating'?'image':stage==='animating'?'animation':'';if(!phase||!['provider_started','provider_failed','illustrated','animated'].includes(status))return false;if(!UUID.test(providerJobId))throw new Error('Invalid provider task checkpoint');const provider=String(body?.provider||'');if(phase==='image'&&provider!=='runway-gen4-image-turbo')throw new Error('Invalid image provider checkpoint');if(phase==='animation'&&!['runway-gen4-turbo','runway-gen4-turbo-motion-retry'].includes(provider))throw new Error('Invalid animation provider checkpoint');const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)throw new Error('Blob storage missing');const record={version:1,sceneNumber:scene,phase,provider,providerJobId,status,retryAttempt:Number(body?.retryAttempt||0),priorProviderJobId:UUID.test(String(body?.priorProviderJobId||''))?String(body.priorProviderJobId):'',updatedAt:new Date().toISOString()};await put(checkpointPath(id,phase,scene),JSON.stringify(record),{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json',token});return true}
const STORY_VIBES=new Set(['surprise me','funny','magical','adventure','heartwarming','mystery','kid-safe spooky']);
function storyMoods(saved){const values=Array.isArray(saved?.moods)?saved.moods:[saved?.selectedVibe];const moods=values.map(value=>String(value||'').trim().toLowerCase()).filter(value=>STORY_VIBES.has(value));return[moods[0]||'surprise me']}
async function contract(id){
  const base='https://main-character-studios.vercel.app/api/internal/pipeline/jobs/'+id;
  const runway=process.env.Runway||process.env.RUNWAY_API_KEY||'';
  const eleven=process.env.ELEVENLABS_API_KEY||process.env.Elevenlabs_Secured_key||process.env.Elevenlabs_Secured_key_2||'';
  const[saved,existingProviderJobs]=await Promise.all([loadStageData(id),loadProviderJobs(id)]);
  const scenes=storyScenes(saved);
  const title=saved.screenplay.title||'Main Character Studios Movie';
  const plan=String(saved.plan||'');
  const originalIdea=typeof saved.originalIdea==='string'?saved.originalIdea:plan;
  const creativeMode=saved.creativeMode==='make_for_me'?'make_for_me':'my_story';
  const storyBrief=saved.storyBrief??originalIdea;
  const sourceLedger=saved.sourceLedger??null;
  const castBindings=saved.screenplay?.sourceCoverage?.characterBindings||[];
  const traits=subjectContract(saved.subjectIdentity);
  const moods=storyMoods(saved);
  const selectedVibe=moods[0];
  return{
    id,orderId:id,tier:'standard_hybrid',vision:plan||originalIdea,
    creativeMode,storyBrief,sourceLedger,castBindings,moods,selectedVibe,original_customer_input:originalIdea,
    approvedPreview:{title,page_title:title,creative_mode:creativeMode,story_brief:storyBrief,source_ledger:sourceLedger,cast_bindings:castBindings,selected_moods:moods,selected_vibe:selectedVibe,story_text:plan,scene_prompt:plan,organized_story:plan,original_customer_input:originalIdea,selected_topic:'',featured_names:scenes[0]?.characters||[],subject_kind:traits.subject_type,character_traits:traits,ambiguity_notes:[],customer_notes:'',character_notes:''},
    subjectIdentity:saved.subjectIdentity||null,ownerQa:false,retryLimitHit:0,resumeStoredAssets:true,
    reusableOwnerSceneNumbers:[1,2,3,4,5,6],reusableOwnerVideoSceneNumbers:[1,2,3,4,5,6],existingProviderJobs,
    existingManifest:{version:4,tier:'three_minute',title,subtitle:'Three-minute personalized moving story',pages:scenes.map(scene=>({sceneNumber:scene.sceneNumber,text:scene.narration})),scenes},
    assets:{reference:base+'/asset?kind=reference',approvedScene:base+'/asset?kind=approved-scene',previewScene:base+'/asset',upload:base+'/asset',illustrate:base+'/illustrate',musicBed:base+'/asset?kind=music-bed'},
    callback:base,rankManifest:base+'/rank',
    providers:{openaiApiKey:'',runwayApiKey:runway,elevenLabsApiKey:eleven,elevenLabsVoiceId:process.env.ELEVENLABS_VOICE_ID||'21m00Tcm4TlvDq8ikWAM',elevenLabsModelId:process.env.ELEVENLABS_MODEL_ID||'eleven_flash_v2_5'},
    contract:{scenes:18,previewScenes:6,secondsPerScene:10,previewSeconds:60,movieSeconds:180,heroScenes:18,subjectCount:traits.subject_count,subjectType:traits.subject_type,heroScoring:false,motion:'runway-gen4-turbo-all-scenes',petMode:traits.subject_type!=='person'&&traits.subject_type!=='people',musicVibe:selectedVibe,musicAssetKind:'music-bed',reusePreviewMusic:true,petRouting:'runway-gen4-turbo-only',animalPoseDetection:false}
  };
}
export default async function handler(req,res){res.setHeader('Cache-Control','private, no-store');if(!auth(req))return res.status(401).send('Unauthorized');const id=String(req.query?.id||'');if(!validJobId(id))return res.status(400).json({error:'Invalid job id'});if(req.method==='GET'){try{return res.status(200).json(await contract(id))}catch(error){return res.status(500).json({error:error.message})}}if(req.method==='PATCH'){try{const checkpointed=await persistProviderCheckpoint(id,req.body||{});return res.status(200).json({ok:true,id,checkpointed})}catch(error){return res.status(503).json({error:error.message})}}return res.status(405).json({error:'Method not allowed'})}
