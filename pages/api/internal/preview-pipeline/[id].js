import{head,put}from'@vercel/blob';
import{subjectContract}from'../../../../lib/subject-contract';
import{persistSavedPreview}from'../../../../lib/saved-previews';
function auth(req){const s=process.env.MCS_WORKER_SECRET||'';const h=req.headers.authorization||'';return !!s&&(h==='Bearer '+s||h===s)}
async function loadStory(id){const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)throw new Error('Blob storage missing');const path=`mcs/jobs/${id}/story-plan.bin`;const meta=await head(path,{token});const r=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`Story fetch failed ${r.status}`);const saved=JSON.parse(await r.text());if(!Array.isArray(saved?.screenplay?.scenes)||saved.screenplay.scenes.length!==18)throw new Error('Structured screenplay missing');return saved}
function previewScenes(saved){return saved.screenplay.scenes.slice(0,6).map((s,i)=>({...s,sceneNumber:i+1,staticLevel:0,hero_scene:true,animationProvider:'runway-gen4-turbo'}))}
import{normalizeMoods}from '../../../../lib/mcs-contract';
function storyMoods(saved){return normalizeMoods(Array.isArray(saved?.moods)?saved.moods:[saved?.selectedVibe]);}
async function contract(id){
  const origin='https://main-character-studios.vercel.app';
  const paidAsset=`${origin}/api/internal/pipeline/jobs/${id}/asset`;
  const runway=process.env.Runway||process.env.RUNWAY_API_KEY||'';
  const eleven=process.env.ELEVENLABS_API_KEY||process.env.Elevenlabs_Secured_key||process.env.Elevenlabs_Secured_key_2||'';
  const saved=await loadStory(id);
  const scenes=previewScenes(saved);
  const title=saved.screenplay.title||'Main Character Studios Preview';
  const traits=subjectContract(saved.subjectIdentity);
  const originalIdea=typeof saved.originalIdea==='string'?saved.originalIdea:String(saved.plan||'');
  const creativeMode=saved.creativeMode==='make_for_me'?'make_for_me':'my_story';
  const storyBrief=saved.storyBrief??originalIdea;
  const sourceLedger=saved.sourceLedger??null;
  const castBindings=saved.screenplay?.sourceCoverage?.characterBindings||[];
  const moods=storyMoods(saved);
  const selectedVibe=moods[0];
  return{
    id,previewId:id,tier:'standard_hybrid',vision:saved.plan||originalIdea,
    creativeMode,storyBrief,sourceLedger,castBindings,moods,selectedVibe,original_customer_input:originalIdea,
    approvedPreview:{title,creative_mode:creativeMode,story_brief:storyBrief,source_ledger:sourceLedger,cast_bindings:castBindings,selected_moods:moods,selected_vibe:selectedVibe,story_text:saved.plan||'',organized_story:saved.plan||'',original_customer_input:originalIdea,featured_names:scenes[0]?.characters||[],subject_kind:traits.subject_type,character_traits:traits},
    subjectIdentity:saved.subjectIdentity||null,
    existingManifest:{version:4,title,subtitle:'The opening minute',pages:scenes.map(s=>({sceneNumber:s.sceneNumber,text:s.narration})),scenes},
    existingProviderJobs:{},
    assets:{reference:`${paidAsset}?kind=reference`,previewScene:paidAsset,upload:paidAsset,musicBed:`${paidAsset}?kind=music-bed`},
    providers:{openaiApiKey:'',runwayApiKey:runway,elevenLabsApiKey:eleven,elevenLabsVoiceId:process.env.ELEVENLABS_VOICE_ID||'21m00Tcm4TlvDq8ikWAM',elevenLabsModelId:process.env.ELEVENLABS_MODEL_ID||'eleven_flash_v2_5'},
    contract:{scenes:6,previewScenes:6,secondsPerScene:10,previewSeconds:60,movieSeconds:60,fullMovieScenes:18,fullMovieSeconds:180,subjectCount:traits.subject_count,subjectType:traits.subject_type,musicVibe:selectedVibe,musicAssetKind:'music-bed',reusePreviewMusic:true,petRouting:'runway-gen4-turbo-only',animalPoseDetection:false}
  };
}
export default async function handler(req,res){if(!auth(req))return res.status(401).send('Unauthorized');const{id}=req.query;if(req.method==='GET'){try{return res.status(200).json(await contract(id))}catch(e){return res.status(500).json({error:e.message})}}if(req.method==='PATCH'){
  const token=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  const body=req.body&&typeof req.body==='object'?req.body:{};
  const scene=Number(body.scene||0);
  const update={...body,scene:Number.isFinite(scene)?scene:0,updatedAt:new Date().toISOString()};
  const path=`mcs/jobs/${id}/progress-${update.scene||0}.json`;
  await put(path,Buffer.from(JSON.stringify(update)),{access:'private',addRandomSuffix:false,allowOverwrite:true,token,contentType:'application/json'});
  if(update.stage==='ready'&&update.status==='ready')await persistSavedPreview(id,token,update.updatedAt);
  console.log('[preview-scene]',JSON.stringify({id,stage:update.stage||'',status:update.status||'',scene:update.scene||0,provider:update.provider||'',providerJobId:update.providerJobId||''}));
  return res.status(200).json({ok:true,id,...update});
}return res.status(405).json({error:'Method not allowed'})}
