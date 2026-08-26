const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadPhotoQuality(){
  const filename=path.join(__dirname,'..','pages','api','photo-quality.js');
  const context=vm.createContext({Buffer,URL,console,fetch:()=>{throw new Error('Network calls are forbidden in this test')},process});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(async specifier=>{
    if(specifier==='@vercel/oidc')return new vm.SyntheticModule(['getVercelOidcToken'],function(){this.setExport('getVercelOidcToken',async()=>{throw new Error('OIDC is forbidden in this test')})},{context});
    if(specifier==='../../lib/photo-entitlement')return new vm.SyntheticModule(['issuePhotoPreviewEntitlement'],function(){this.setExport('issuePhotoPreviewEntitlement',()=> 'test-entitlement')},{context});
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

function jpegDataUrl(bytes=32){
  const buffer=Buffer.alloc(bytes,0x11);
  buffer[0]=0xff;buffer[1]=0xd8;buffer[2]=0xff;
  return`data:image/jpeg;base64,${buffer.toString('base64')}`;
}

test('accepts valid JPEG data and rejects damaged or unsupported payloads',async()=>{
  const api=await loadPhotoQuality();
  assert.equal(api.normalizePhotoDataUrl(jpegDataUrl()),jpegDataUrl());
  assert.throws(()=>api.normalizePhotoDataUrl('data:image/gif;base64,R0lGODlh'),/JPEG, PNG, or WebP/);
  assert.throws(()=>api.normalizePhotoDataUrl(`data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}`),/damaged or unreadable/);
});

test('allows normal good and caution results but requires a real retry issue to block',async()=>{
  const api=await loadPhotoQuality();
  assert.equal(api.normalizeQualityResult({status:'good',blockingIssue:'none',reason:'Clear enough.',tip:'Continue.',visiblePrincipalSubjectCount:2}).status,'good');
  assert.equal(api.normalizeQualityResult({status:'caution',blockingIssue:'none',reason:'A little dim.',tip:'A brighter copy may match better.',visiblePrincipalSubjectCount:1}).status,'caution');
  assert.equal(api.normalizeQualityResult({status:'retry_required',blockingIssue:'none',reason:'Not perfect.',tip:'Retry.',visiblePrincipalSubjectCount:1}).status,'caution');
  assert.equal(api.normalizeQualityResult({status:'retry_required',blockingIssue:'severe_blur',reason:'No features are readable.',tip:'Try a sharper frame.',visiblePrincipalSubjectCount:1}).status,'retry_required');
});

test('enforces same-origin requests in production without affecting development',async()=>{
  const api=await loadPhotoQuality();
  const sameOrigin={headers:{host:'main-character-studios.vercel.app','x-forwarded-proto':'https',origin:'https://main-character-studios.vercel.app','sec-fetch-site':'same-origin'}};
  assert.doesNotThrow(()=>api.assertSameOrigin(sameOrigin,'production'));
  assert.throws(()=>api.assertSameOrigin({...sameOrigin,headers:{...sameOrigin.headers,origin:'https://example.com','sec-fetch-site':'cross-site'}},'production'),/this site/);
  assert.doesNotThrow(()=>api.assertSameOrigin({headers:{}},'development'));
});

test('provider failure is a non-blocking caution response',async()=>{
  const api=await loadPhotoQuality();
  const req={method:'POST',headers:{},body:{image:jpegDataUrl()}};
  let code=0;let body;
  const res={setHeader(){},status(value){code=value;return this},json(value){body=value;return value}};
  await api.default(req,res);
  assert.equal(code,200);
  assert.equal(body.status,'caution');
  assert.equal(body.previewEntitlement,'test-entitlement');
  assert.match(body.reason,/did not block/);
});
