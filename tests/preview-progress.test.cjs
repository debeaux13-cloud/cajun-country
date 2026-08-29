const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const ID='11111111-1111-4111-8111-111111111111';

function load({global={},scenes={},assets={}}={}){
  const source=fs.readFileSync(path.join(__dirname,'..','pages','api','preview-progress.js'),'utf8')
    .replace("import{head}from'@vercel/blob';","const {head}=blob;")
    .replace('export default async function handler','async function handler')+'\nmodule.exports=handler;';
  const records={ [`mcs/jobs/${ID}/progress-0.json`]:global };
  for(const [scene,value] of Object.entries(scenes))records[`mcs/jobs/${ID}/progress-${scene}.json`]=value;
  const blob={head:async pathname=>{
    if(pathname.endsWith('preview-movie.bin')){if(!assets.movie)throw new Error('missing');return assets.movie}
    if(pathname.endsWith('preview-storybook-pdf.bin')){if(!assets.pdf)throw new Error('missing');return assets.pdf}
    if(!(pathname in records))throw new Error('missing');
    return{url:'blob://'+pathname};
  }};
  const context={module:{exports:{}},blob,process:{env:{BLOB_READ_WRITE_TOKEN:'token'}},Promise,Number,String,Boolean,Math,JSON,encodeURIComponent,fetch:async url=>({ok:true,json:async()=>records[String(url).replace('blob://','')]})};
  vm.runInNewContext(source,context);return context.module.exports;
}
async function request(fixture){const handler=load(fixture);const res={status(code){this.code=code;return this},setHeader(){},json(body){this.body=body;return this}};await handler({method:'GET',query:{mcsJobId:ID}},res);return res.body}
const movie={contentType:'video/mp4',size:600000};const pdf={contentType:'application/pdf',size:2000};

test('progress without global ready remains working',async()=>{const body=await request({global:{stage:'animating'}});assert.equal(body.status,'IN_PROGRESS');assert.equal(body.storedPreviewReady,false);});
test('scene ready cannot complete the Preview',async()=>{const body=await request({global:{stage:'animating'},scenes:{1:{stage:'sound',status:'ready'}},assets:{movie,pdf}});assert.equal(body.status,'IN_PROGRESS');assert.equal(body.storedPreviewReady,false);});
test('global ready without movie is not complete',async()=>{const body=await request({global:{stage:'ready'},assets:{pdf}});assert.equal(body.status,'IN_PROGRESS');assert.equal(body.storedPreviewReady,false);});
test('global ready with movie but no PDF is not complete',async()=>{const body=await request({global:{status:'ready'},assets:{movie}});assert.equal(body.status,'IN_PROGRESS');assert.equal(body.storedPreviewReady,false);});
test('global ready with valid movie and PDF completes the Preview',async()=>{const body=await request({global:{stage:'ready'},assets:{movie,pdf}});assert.equal(body.status,'COMPLETED');assert.equal(body.storedPreviewReady,true);assert.equal(body.progress,100);assert.equal(body.videoUrl,'/api/preview-media?id='+ID);});
test('manual review and failure are terminal and expose stored errors',async()=>{for(const global of [{stage:'manual_review',error:'Needs review'},{status:'failed',error:'Render failed'}]){const body=await request({global});assert.ok(['MANUAL_REVIEW','FAILED'].includes(body.status));assert.equal(body.storedPreviewReady,false);assert.equal(body.error,global.error);}});
test('Preview page polls only durable Preview progress and submits mcsJobId to checkout',()=>{const source=fs.readFileSync(path.join(__dirname,'..','pages','preview.js'),'utf8');assert.doesNotMatch(source,/fetch\('\/api\/job/);assert.match(source,/fetch\('\/api\/preview-progress\?mcsJobId='/);assert.match(source,/body:JSON\.stringify\(\{mcsJobId\}\)/);assert.match(source,/terminalStatuses\.includes\(String\(next\.status\|\|''\)\.toUpperCase\(\)\)/);});
test('legacy job status API stays untouched',()=>{const source=fs.readFileSync(path.join(__dirname,'..','pages','api','job.js'),'utf8');assert.match(source,/getPreviewClaimByMcsJobId/);assert.match(source,/\/status\//);});
