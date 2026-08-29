import {MCS_NEGATIVE_STYLE,MCS_VISUAL_STYLE,normalizeMoods} from './mcs-contract';

const BANNED_META_PHRASES=[
  'the story continues',
  'the adventure gets richer',
  'something ridiculous is about to happen',
  'what happens next',
  'the story comes alive',
  'carrying the heart of the story forward',
  'in this scene',
  'the next scene',
  'the screenplay',
  'the camera pans',
  'the camera zooms',
  'our story continues'
];
const CAMERA=['tracking shot','medium follow','low-angle chase','wide reveal','side tracking','gentle push-in','over-the-shoulder reaction','orbit during action'];
const ACTION=/\b(run|runs|walk|walks|turn|turns|open|opens|grab|grabs|lift|lifts|pull|pulls|push|pushes|climb|climbs|jump|jumps|reach|reaches|catch|catches|carry|carries|search|searches|find|finds|help|helps|chase|chases|ride|rides|dance|dances|build|builds|throw|throws|point|points|wave|waves|follow|follows|enter|enters|leave|leaves|cross|crosses|step|steps|duck|ducks|dodge|dodges|hold|holds|pick|picks|place|places|drop|drops|look|looks|race|races|charge|charges|crawl|crawls|trot|trots|leap|leaps)\b/ig;
const words=value=>String(value||'').trim().split(/\s+/).filter(Boolean);
const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const containsTerm=(text,value)=>{const term=normalize(value);return Boolean(term)&&` ${normalize(text)} `.includes(` ${term} `);};

export function validateStageScenes(scenes){
  if(!Array.isArray(scenes)||scenes.length!==18)throw new Error('Stage must supply exactly 18 scenes.');
  const narrations=new Set();
  return scenes.map((scene,index)=>{
    const narration=String(scene?.narration||'').trim();
    const count=words(narration).length;
    if(Number(scene?.sceneNumber)!==index+1||!String(scene?.title||'').trim()||!String(scene?.location||'').trim()||!String(scene?.visual||'').trim())throw new Error(`Stage scene ${index+1} is incomplete.`);
    if(count<16||count>22)throw new Error(`Stage scene ${index+1} narration must be 16–22 naturally spoken words.`);
    if(BANNED_META_PHRASES.some(phrase=>narration.toLowerCase().includes(phrase)))throw new Error(`Stage scene ${index+1} contains banned meta-story narration.`);
    const normalized=narration.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    if(narrations.has(normalized))throw new Error('Stage narration repeats a template.');
    narrations.add(normalized);
    return {...scene,sceneNumber:index+1,narration};
  });
}

function productionBindings(stage,subjectIdentity){
  const subjects=Array.isArray(subjectIdentity?.subjects)?subjectIdentity.subjects:[];
  const visibleCast=Array.isArray(stage?.sourceLedger?.visibleCast)?stage.sourceLedger.visibleCast.map(String).filter(Boolean):[];
  return subjects.map((subject,index)=>({
    storyIdentity:visibleCast[index]||`uploaded subject ${subject.subjectId}`,
    productionSubjectId:subject.subjectId,
    role:index===0?'principal uploaded subject':'uploaded supporting subject',
    continuityRule:'Keep this uploaded subject distinct; never merge, swap, hybridize, duplicate, or transfer traits.',
    isExplicitSourceAlias:false,
    aliasOfStoryIdentity:''
  }));
}

function subjectCharacterFactIds(stage,bindings){
  const facts=Array.isArray(stage?.sourceLedger?.requiredSourceFacts)?stage.sourceLedger.requiredSourceFacts:[];
  const characterFacts=facts.filter(fact=>String(fact?.category||'')==='character');
  const map=new Map();
  for(const binding of bindings){
    const ids=characterFacts
      .filter(fact=>containsTerm(fact?.detail,binding.storyIdentity))
      .map(fact=>String(fact?.id||'').trim())
      .filter(Boolean);
    map.set(binding.productionSubjectId,new Set(ids));
  }
  return map;
}

function sceneBindings(scene,bindings,factIdsBySubject){
  const sceneFacts=new Set(Array.isArray(scene?.sourceFactIds)?scene.sourceFactIds.map(value=>String(value||'').trim()).filter(Boolean):[]);
  return bindings.filter(binding=>{
    const factIds=factIdsBySubject.get(binding.productionSubjectId)||new Set();
    return [...factIds].some(id=>sceneFacts.has(id));
  });
}

function motion(scene,index){
  const event=String(scene.visual||'').replace(/\s+/g,' ').trim();
  const verbs=[...event.matchAll(ACTION)].map(match=>match[0].toLowerCase());
  const unique=[...new Set(verbs)];
  const primary=unique[0]||'moves';
  const keyActionVerbs=(unique.length>=3?unique.slice(0,3):[...unique,'repositions','interacts']).slice(0,3);
  return {
    keyActionVerbs,
    motionBeats:[
      `0–3 sec: the visible character begins the physical action immediately, starting to ${primary} within this exact event: ${event}`,
      `3–7 sec: the visible character changes position and physically interacts with the specific person, prop, obstacle, or environment already present in this event: ${event}`,
      `7–10 sec: that same action reaches a visible consequence or reaction that completes this story beat without inventing a new event: ${event}`
    ],
    camera:CAMERA[(index-1)%CAMERA.length]
  };
}

export function enrichStageScreenplay(stage,{moods=[],subjectIdentity=null}={}){
  const bindings=productionBindings(stage,subjectIdentity);
  const factIdsBySubject=subjectCharacterFactIds(stage,bindings);
  const scenes=validateStageScenes(stage?.scenes).map((scene,index)=>{
    const present=sceneBindings(scene,bindings,factIdsBySubject);
    const m=motion(scene,scene.sceneNumber);
    return {
      sceneNumber:scene.sceneNumber,
      title:scene.title,
      location:scene.location,
      setting:scene.location,
      narration:scene.narration,
      visual:scene.visual,
      description:scene.visual,
      sourceFactIds:[...(scene.sourceFactIds||[])],
      characters:present.map(binding=>`${binding.productionSubjectId}: ${binding.storyIdentity}`),
      productionSubjectBindings:present.map(binding=>binding.productionSubjectId),
      characterBindings:present,
      supportingCharacters:[],
      visibleAction:scene.visual,
      camera:m.camera,
      requiredVisibleDetails:[scene.location,scene.visual],
      keyActionVerbs:m.keyActionVerbs,
      motionBeats:m.motionBeats,
      identityLock:subjectIdentity?.identityDescription||'',
      visualStyle:MCS_VISUAL_STYLE,
      negativeStyle:MCS_NEGATIVE_STYLE
    };
  });
  return {
    version:7,
    title:String(stage?.title||'Main Character Studios Movie'),
    moods:normalizeMoods(moods),
    visualStyle:MCS_VISUAL_STYLE,
    negativeStyle:MCS_NEGATIVE_STYLE,
    sourceCoverage:{characterBindings:bindings},
    pages:scenes.map(scene=>({sceneNumber:scene.sceneNumber,text:scene.narration})),
    scenes
  };
}
