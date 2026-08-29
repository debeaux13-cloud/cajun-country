const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadValidator(){
  const filename=path.join(__dirname,'..','pages','api','stage.js');
  const context=vm.createContext({Buffer,console,fetch:()=>{throw new Error('Network calls are forbidden in this test')},process});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(async specifier=>{
    if(specifier==='@vercel/oidc')return new vm.SyntheticModule(['getVercelOidcToken'],function(){this.setExport('getVercelOidcToken',async()=>{throw new Error('OIDC is forbidden in this test')})},{context});
    if(specifier==='../../lib/mcs-contract')return new vm.SyntheticModule(['normalizeMoods'],function(){this.setExport('normalizeMoods',()=>['surprise me'])},{context});
    if(specifier==='../../lib/stage-production')return new vm.SyntheticModule(['validateStageScenes'],function(){this.setExport('validateStageScenes',value=>value)},{context});
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace.validatePhotoCastCoverage;
}

test('requires a separate character fact for every visible photo star in either mode',async()=>{
  const validate=await loadValidator();
  const ledger={
    creativeMode:'my_story',
    visibleCast:['the older child','the tabby cat'],
    requiredSourceFacts:[
      {id:'FACT-001',category:'character',detail:'the older child is the brave explorer'},
      {id:'FACT-002',category:'character',detail:'the tabby cat is the clever guide'}
    ]
  };
  assert.doesNotThrow(()=>validate(ledger,true));
  assert.throws(()=>validate({...ledger,requiredSourceFacts:ledger.requiredSourceFacts.slice(0,1)},true),/tabby cat/);
  assert.doesNotThrow(()=>validate({...ledger,visibleCast:[],requiredSourceFacts:[]},false));
});
