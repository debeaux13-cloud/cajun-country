import {MCS_NEGATIVE_STYLE,MCS_VISUAL_STYLE,normalizeMoods} from './mcs-contract';
const BANNED=['the story continues','the adventure gets richer','something ridiculous is about to happen','what happens next','the story comes alive','carrying the heart of the story forward','screenplay','production','camera'];
const words=value=>String(value||'').trim().split(/\s+/).filter(Boolean);
export function validateStageScenes(scenes){
 if(!Array.isArray(scenes)||scenes.length!==18)throw new Error('Stage must supply exactly 18 scenes.');
 const narrations=new Set();
 return scenes.map((scene,index)=>{
  const narration=String(scene?.narration||'').trim(); const count=words(narration).length;
  if(Number(scene?.sceneNumber)!==index+1||!String(scene?.title||'').trim()||!String(scene?.location||'').trim()||!String(scene?.visual||'').trim())throw new Error(`Stage scene ${index+1} is incomplete.`);
  if(count<16||count>22)throw new Error(`Stage scene ${index+1} narration must be 16–22 naturally spoken words.`);
  if(BANNED.some(phrase=>narration.toLowerCase().includes(phrase)))throw new Error(`Stage scene ${index+1} contains banned meta-story narration.`);
  const normalized=narration.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); if(narrations.has(normalized))throw new Error('Stage narration repeats a template.');narrations.add(normalized);
  return {...scene,sceneNumber:index+1,narration};
 });
}
export function enrichStageScreenplay(stage,{moods=[],subjectIdentity=null}={}){
 const scenes=validateStageScenes(stage?.scenes).map(scene=>({
  sceneNumber:scene.sceneNumber,title:scene.title,location:scene.location,setting:scene.location,narration:scene.narration,visual:scene.visual,description:scene.visual,sourceFactIds:scene.sourceFactIds,
  productionSubjectBindings:subjectIdentity?.subjects?.map(subject=>subject.subjectId)||[],identityLock:subjectIdentity?.identityDescription||'',supportingCharacters:[],
  visibleAction:scene.visual,camera:'cinematic full-body composition',requiredVisibleDetails:[scene.location,scene.visual],keyActionVerbs:['moves','reacts','interacts'],motionBeats:[scene.visual,scene.visual,scene.visual],
  visualStyle:MCS_VISUAL_STYLE,negativeStyle:MCS_NEGATIVE_STYLE
 }));
 return {version:5,title:String(stage?.title||'Main Character Studios Movie'),moods:normalizeMoods(moods),visualStyle:MCS_VISUAL_STYLE,negativeStyle:MCS_NEGATIVE_STYLE,pages:scenes.map(s=>({sceneNumber:s.sceneNumber,text:s.narration})),scenes};
}
