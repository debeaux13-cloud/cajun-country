const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadPreviewGuard(){
  const filename=path.join(__dirname,'..','lib','preview-guard.js');
  const context=vm.createContext({console,fetch:()=>{throw new Error('Network calls are forbidden in this test')},process:{env:{VERCEL_ENV:'production'}}});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(async specifier=>{
    if(specifier==='crypto')return new vm.SyntheticModule(['default'],function(){this.setExport('default',crypto)},{context});
    if(specifier==='@vercel/blob'){
      class BlobNotFoundError extends Error{}
      return new vm.SyntheticModule(['BlobNotFoundError','head','list','put'],function(){
        this.setExport('BlobNotFoundError',BlobNotFoundError);
        this.setExport('head',async()=>{throw new Error('Blob calls are forbidden in this test')});
        this.setExport('list',async()=>{throw new Error('Blob calls are forbidden in this test')});
        this.setExport('put',async()=>{throw new Error('Blob calls are forbidden in this test')});
      },{context});
    }
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

const REQUEST_ID='4f5d3e62-73dc-44ae-8be2-d992166c1fc3';

test('requires a UUIDv4 preview request ID',async()=>{
  const guard=await loadPreviewGuard();
  assert.equal(guard.normalizePreviewRequestId(REQUEST_ID),REQUEST_ID);
  assert.throws(()=>guard.normalizePreviewRequestId('not-a-preview-id'),/valid preview request/i);
  assert.throws(()=>guard.normalizePreviewRequestId('4f5d3e62-73dc-14ae-8be2-d992166c1fc3'),/valid preview request/i);
});

test('binds a preview request to the complete selected story and photo',async()=>{
  const guard=await loadPreviewGuard();
  const base={creativeMode:'make_for_me',originalIdea:'',sourceLedger:{facts:[]},plan:'A moonlit adventure',image:'data:image/jpeg;base64,/9j/',moods:['magical']};
  const hash=guard.previewRequestHash(base);
  assert.equal(hash,guard.previewRequestHash({...base}));
  assert.notEqual(hash,guard.previewRequestHash({...base,plan:'A rodeo adventure'}));
  assert.notEqual(hash,guard.previewRequestHash({...base,image:'data:image/jpeg;base64,/9j/AA=='}));
});

test('returns the same accepted job and refuses request-ID reuse for changed content',async()=>{
  const guard=await loadPreviewGuard();
  const hash='abc123';
  const submitted={requestHash:hash,status:'submitted',mcsJobId:'mcs-one',jobId:'runpod-one'};
  assert.equal(guard.classifyPreviewClaim(submitted,hash).state,'submitted');
  assert.deepEqual({...guard.previewClaimResponse(submitted)},{ok:true,mcsJobId:'mcs-one',jobId:'runpod-one',status:'submitted'});
  assert.throws(()=>guard.classifyPreviewClaim(submitted,'different-story'),/different story content/i);
  assert.equal(guard.classifyPreviewClaim({requestHash:hash,status:'submitting'},hash).state,'pending');
  assert.throws(()=>guard.classifyPreviewClaim({requestHash:hash,status:'submission_unknown'},hash),/may already be running/i);
});

test('production preview submissions must come from the official create site',async()=>{
  const guard=await loadPreviewGuard();
  assert.doesNotThrow(()=>guard.enforceOfficialPreviewOrigin({headers:{origin:'https://main-character-studios.vercel.app'}}));
  assert.throws(()=>guard.enforceOfficialPreviewOrigin({headers:{origin:'https://example.com'}}),/official Main Character Studios/i);
});

test('allows only a marked Preview retry reservation',async()=>{
  const guard=await loadPreviewGuard();
  assert.equal(guard.classifyPreviewClaim({requestHash:'x',status:'retrying'},'x').state,'reserved');
  assert.throws(()=>guard.classifyPreviewClaim({requestHash:'x',status:'retrying'},'other'),/different story content/i);
});
