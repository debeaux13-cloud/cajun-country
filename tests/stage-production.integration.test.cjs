const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');

async function load(){
  const root=path.join(__dirname,'..');
  const context=vm.createContext({});
  const synthetic=new vm.SyntheticModule(['MCS_NEGATIVE_STYLE','MCS_VISUAL_STYLE','normalizeMoods'],function(){
    this.setExport('MCS_NEGATIVE_STYLE','negative');
    this.setExport('MCS_VISUAL_STYLE','style');
    this.setExport('normalizeMoods',value=>Array.isArray(value)&&value.length?value:['surprise me']);
  },{context});
  const mod=new vm.SourceTextModule(fs.readFileSync(path.join(root,'lib/stage-production.js'),'utf8'),{context,identifier:'stage'});
  await mod.link(specifier=>{if(specifier==='./mcs-contract')return synthetic;throw new Error(specifier)});
  await mod.evaluate();
  return mod.namespace;
}

const narration=n=>`Maya walks through glowing garden ${n}, follows a silver clue, faces a small surprise, and discovers a hopeful path forward.`;
const visual=n=>`Maya opens gate ${n} and carries a silver lantern across the garden while the path changes ahead.`;

function stageFixture(){
  const facts=[
    {id:'CAST-MAYA',category:'character',detail:'Maya',sourceOrder:1},
    {id:'CAST-PIP',category:'character',detail:'Pip',sourceOrder:2},
    {id:'CAST-NOVA',category:'character',detail:'Nova',sourceOrder:3}
  ];
  const scenes=Array.from({length:18},(_,index)=>{
    const n=index+1;
    const membership=n===1?['CAST-MAYA']:n===2?['CAST-MAYA','CAST-PIP']:n===3?['CAST-NOVA']:['CAST-MAYA'];
    return {sceneNumber:n,title:`Title ${n}`,location:`Location ${n}`,narration:narration(n),visual:visual(n),sourceFactIds:membership};
  });
  return {
    title:'Maya Story',
    sourceLedger:{visibleCast:['Maya','Pip','Nova'],namedCharacters:[],requiredSourceFacts:facts},
    scenes
  };
}

const identity={subjects:[
  {subjectId:'S1',identityDescription:'Maya identity',referencePosition:'left',kind:'person',keyMarkers:[]},
  {subjectId:'S2',identityDescription:'Pip identity',referencePosition:'center',kind:'dog',keyMarkers:[]},
  {subjectId:'S3',identityDescription:'Nova identity',referencePosition:'right',kind:'cat',keyMarkers:[]}
]};

test('Stage story truth remains immutable through production enrichment',async()=>{
  const {enrichStageScreenplay}=await load();
  const stage=stageFixture();
  const result=enrichStageScreenplay(stage,{moods:['dramatic'],subjectIdentity:identity});
  assert.equal(result.scenes.length,18);
  for(let index=0;index<18;index++){
    const original=stage.scenes[index],enriched=result.scenes[index];
    for(const key of ['sceneNumber','title','location','narration','visual','sourceFactIds'])assert.equal(JSON.stringify(enriched[key]),JSON.stringify(original[key]));
    assert.equal(new Set(enriched.motionBeats).size,3);
  }
  assert.notEqual(result.scenes[0].camera,result.scenes[1].camera);
});

test('scene-level uploaded subject membership is exact for three subjects',async()=>{
  const {enrichStageScreenplay}=await load();
  const result=enrichStageScreenplay(stageFixture(),{moods:['dramatic'],subjectIdentity:identity});
  assert.deepEqual([...result.scenes[0].productionSubjectBindings],['S1']);
  assert.deepEqual([...result.scenes[1].productionSubjectBindings],['S1','S2']);
  assert.deepEqual([...result.scenes[2].productionSubjectBindings],['S3']);
  assert.match(result.scenes[0].characters.join(' '),/S1: Maya/);
  assert.doesNotMatch(result.scenes[0].characters.join(' '),/S2:|S3:/);
  assert.match(result.scenes[1].characters.join(' '),/S1: Maya/);
  assert.match(result.scenes[1].characters.join(' '),/S2: Pip/);
  assert.doesNotMatch(result.scenes[1].characters.join(' '),/S3:/);
  assert.match(result.scenes[2].characters.join(' '),/S3: Nova/);
  assert.doesNotMatch(result.scenes[2].characters.join(' '),/S1:|S2:/);
  assert.ok(result.scenes[0].characters.length>0,'protagonist must not disappear');
  assert.ok(result.scenes[2].characters.length>0,'scene-specific uploaded subject must not disappear');
});

test('Stage narration rejects meta-story filler but permits production and camera as story nouns',async()=>{
  const {validateStageScenes}=await load();
  const scenes=stageFixture().scenes.map((scene,index)=>({...scene,narration:`Maya carries the old production camera through garden ${index+1}, finds a silver key, and smiles as her friend opens the gate.`}));
  assert.doesNotThrow(()=>validateStageScenes(scenes));
  scenes[0].narration='The story continues as Maya carries the old camera through the garden, finds a silver key, and smiles warmly at her friend.';
  assert.throws(()=>validateStageScenes(scenes),/banned meta-story/);
});
