const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadEntitlement(){
  const filename=path.join(__dirname,'..','lib','photo-entitlement.js');
  const context=vm.createContext({Buffer,Date,process:{env:{PREVIEW_ENTITLEMENT_SECRET:'test-secret-with-more-than-24-characters'}}});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(async specifier=>{
    if(specifier==='crypto')return new vm.SyntheticModule(['default'],function(){this.setExport('default',crypto)},{context});
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

const photo=value=>`data:image/jpeg;base64,${Buffer.from(value).toString('base64')}`;

test('one photo receives one deterministic preview entitlement shared by every text draft',async()=>{
  const api=await loadEntitlement();
  const first=api.issuePhotoPreviewEntitlement(photo('same-photo'));
  const second=api.issuePhotoPreviewEntitlement(photo('same-photo'));
  assert.equal(first,second);
  assert.equal(api.verifyPhotoPreviewEntitlement(first,photo('same-photo')),api.previewRequestIdFromEntitlement(first));
  assert.throws(()=>api.verifyPhotoPreviewEntitlement(first,photo('different-photo')),/different photo/i);
});

test('tampered preview entitlements are rejected',async()=>{
  const api=await loadEntitlement();
  const token=api.issuePhotoPreviewEntitlement(photo('same-photo'));
  assert.throws(()=>api.previewRequestIdFromEntitlement(token.slice(0,-1)+(token.endsWith('a')?'b':'a')),/invalid/i);
});
