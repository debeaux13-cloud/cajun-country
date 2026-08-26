const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadValidator(){
  const filename=path.join(__dirname,'..','pages','api','_story-screenplay.js');
  const context=vm.createContext({Buffer,console,fetch:()=>{throw new Error('Network calls are forbidden in this test')},process});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(async specifier=>{
    if(specifier!=='@vercel/oidc')throw new Error(`Unexpected import ${specifier}`);
    return new vm.SyntheticModule(['getVercelOidcToken'],function(){this.setExport('getVercelOidcToken',async()=>{throw new Error('OIDC is forbidden in this test')})},{context});
  });
  await module.evaluate();
  return module.namespace;
}

const roster=[{subjectId:'S1',kind:'person',apparentAgeGroup:'child'}];
const childBinding={storyIdentity:'Maya',productionSubjectId:'S1',role:'curious child adventurer',continuityRule:'Maya stays an age-appropriate child explorer',isExplicitSourceAlias:false,aliasOfStoryIdentity:''};

function scene(narration){
  return{
    sceneNumber:1,title:'The rope bridge',narration,description:narration,setting:'enchanted forest',
    characters:['S1: Maya'],supportingCharacters:[],visibleAction:narration,camera:'wide tracking view',emotionalTone:'brave',
    keyActionVerbs:['runs','jumps','catches'],requiredVisibleDetails:['rope bridge'],motionBeats:['Maya runs','Maya jumps','Maya cheers']
  };
}

test('rejects a child bound as a parent or adult worker',async()=>{
  const{validateAgeRoleSafety:validate}=await loadValidator();
  assert.throws(()=>validate([{...childBinding,role:'mother and office manager'}],[scene('S1: Maya walks into town.')],roster),/adult identity or role/);
  assert.throws(()=>validate([childBinding],[scene('S1: Maya works as a lawyer in the city office.')],roster),/adult role in scene/);
});

test('allows an age-appropriate child adventure',async()=>{
  const{validateAgeRoleSafety:validate}=await loadValidator();
  assert.doesNotThrow(()=>validate([childBinding],[scene('S1: Maya races across the rope bridge, catches the glowing map, and cheers with her friends.')],roster));
});

test('requires one primary binding and a scene appearance for every photo subject',async()=>{
  const{validateCharacterBindings:validate}=await loadValidator();
  const second={...childBinding,storyIdentity:'Pip',productionSubjectId:'S2'};
  assert.throws(()=>validate({characterBindings:[childBinding]},new Set(['S1','S2']),[scene('S1: Maya runs across the bridge.')]),/S2 must have exactly one primary story identity/);
  const firstScene=scene('S1: Maya runs across the bridge.');
  const secondScene={...scene('S2: Pip catches the map.'),sceneNumber:2,characters:['S2: Pip']};
  assert.doesNotThrow(()=>validate({characterBindings:[childBinding,second]},new Set(['S1','S2']),[firstScene,secondScene]));
});
