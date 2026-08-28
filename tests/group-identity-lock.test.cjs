const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadIdentityLocker(){
  const filename=path.join(__dirname,'..','pages','api','preview.js');
  const context=vm.createContext({Buffer,console,fetch:()=>{throw new Error('Network calls are forbidden in this test')},process});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const[name,value]of Object.entries(exports))this.setExport(name,value)},{context});
  await module.link(async specifier=>{
    if(specifier==='crypto')return synthetic({default:{randomUUID:()=>''}});
    if(specifier==='@vercel/blob')return synthetic({put:async()=>({})});
    if(specifier==='@vercel/oidc')return synthetic({getVercelOidcToken:async()=>''});
    if(specifier==='./_runpod')return synthetic({runpod:()=>({})});
    if(specifier==='../../lib/preview-worker-orchestrator')return synthetic({submitPreviewJob:async()=>({})});
    if(specifier==='./_story-screenplay')return synthetic({compileStoryScreenplay:async()=>({})});
    if(specifier==='../../lib/subject-contract')return synthetic({
      MAX_REFERENCE_SUBJECTS:12,
      normalizeSubjects:identity=>(identity.subjects||[]).slice(0,12).map((subject,index)=>({...subject,subjectId:`S${index+1}`}))
    });
    if(specifier==='../../lib/preview-guard')return synthetic({
      classifyPreviewClaim:()=>({}),
      enforceOfficialPreviewOrigin:()=>{},
      enforcePreviewRateLimit:async()=>{},
      getPreviewClaim:async()=>null,
      normalizePreviewRequestId:value=>value,
      previewClaimResponse:()=>({}),
      previewRequestHash:()=>'',
      reservePreviewClaim:async()=>({}),
      retryFailedPreviewClaim:async()=>({}),
      updatePreviewClaim:async()=>({})
    });
    if(specifier==='../../lib/photo-entitlement')return synthetic({
      previewRequestIdFromEntitlement:()=>'',
      verifyPhotoPreviewEntitlement:()=>''
    });
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.lockScreenplayIdentity;
}

test('budgets all twelve identities and selects only scene-listed subjects',async()=>{
  const lock=await loadIdentityLocker();
  const subjects=Array.from({length:12},(_,index)=>({
    subjectId:`S${index+1}`,
    referencePosition:`subject ${index+1} from the left`,
    kind:index%3===0?'person':'dog',
    apparentAgeGroup:index%3===0?'child':'not_applicable',
    species:index%3===0?'human':'dog',
    primaryBreedGuess:index%3===0?'':`breed ${index+1}`,
    keyMarkers:[`marker ${index+1}`],
    identityDescription:`exact face, build, colors, and proportions for subject ${index+1}`,
    uncertainDetails:[]
  }));
  const characterBindings=subjects.map((subject,index)=>({
    storyIdentity:`friend ${index+1}`,productionSubjectId:subject.subjectId,role:'friend',continuityRule:'stay distinct',isExplicitSourceAlias:false,aliasOfStoryIdentity:''
  }));
  const allCharacters=subjects.map((subject,index)=>`${subject.subjectId}: friend ${index+1}`);
  const screenplay={sourceCoverage:{characterBindings},scenes:[
    {sceneNumber:1,characters:allCharacters,identityLock:'old all-subject wording'},
    {sceneNumber:2,characters:['S2: friend 2'],identityLock:'old all-subject wording'}
  ]};
  const result=lock(screenplay,{subjects});
  assert.equal(result.scenes[0].referenceSubjectIds.length,12);
  assert.ok(result.scenes[0].identityLock.length<=500);
  assert.match(result.scenes[0].identityLock,/\bS1=/);
  assert.match(result.scenes[0].identityLock,/\bS12=/);
  assert.deepEqual([...result.scenes[1].referenceSubjectIds],['S2']);
  assert.match(result.scenes[1].identityLock,/\bS2=/);
  assert.doesNotMatch(result.scenes[1].identityLock,/\bS1=/);
  assert.match(result.scenes[1].identityLock,/others stay off-screen/);
});
