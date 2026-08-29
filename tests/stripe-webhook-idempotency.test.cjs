const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const ID='11111111-1111-4111-8111-111111111111';
const SECRET='whsec_test';
function load(store,runs,{reject=false}={}){
  const source=fs.readFileSync(path.join(__dirname,'..','pages','api','stripe','webhook.js'),'utf8')
    .replace("import crypto from 'crypto';","const crypto=require('crypto');")
    .replace("import {head,put} from '@vercel/blob';","const {head,put}=blob;")
    .replace("import {runpod} from '../_runpod';","const {runpod}=runpodModule;")
    .replace('export const config={api:{bodyParser:false}};','const config={api:{bodyParser:false}};')
    .replace('export default async function handler','async function handler')+'\nmodule.exports=handler;';
  const blob={
    head:async pathname=>{if(!(pathname in store))throw new Error('missing');return{url:'blob://'+pathname}},
    put:async(pathname,value,options)=>{if(options.allowOverwrite===false&&pathname in store)throw new Error('exists');store[pathname]=JSON.parse(value)}
  };
  const context={module:{exports:{}},require,crypto,Buffer,Date,Math,Number,String,JSON,Set,Promise,console:{error:()=>{}},process:{env:{STRIPE_WEBHOOK_SECRET:SECRET,BLOB_READ_WRITE_TOKEN:'blob'}},blob,runpodModule:{runpod:()=>({key:'runpod-key',base:'https://runpod.test'})},fetch:async(url)=>{
    if(String(url).startsWith('blob://'))return{ok:true,json:async()=>store[String(url).slice(7)]};
    if(String(url)==='https://runpod.test/run'){runs.count++;if(reject)return{ok:false,json:async()=>({error:'rejected'})};return{ok:true,json:async()=>({id:'paid-job-1',status:'IN_QUEUE'})};}
    throw new Error('unexpected fetch '+url);
  }};
  vm.runInNewContext(source,context);return context.module.exports;
}
function event(id,sessionId='cs_1'){return{id,type:'checkout.session.completed',livemode:false,data:{object:{id:sessionId,payment_intent:'pi_1',payment_status:'paid',mode:'payment',amount_total:4900,currency:'usd',metadata:{product:'mcs_3_minute_movie',mcsJobId:ID}}}}}
async function invoke(handler,data){const body=Buffer.from(JSON.stringify(data));const timestamp=Math.floor(Date.now()/1000);const signature=crypto.createHmac('sha256',SECRET).update(Buffer.concat([Buffer.from(timestamp+'.'),body])).digest('hex');const req={method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},async *[Symbol.asyncIterator](){yield body}};const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};await handler(req,res);return res}

test('same Stripe event dispatches one paid RunPod job',async()=>{const store={},runs={count:0},handler=load(store,runs);await invoke(handler,event('evt_1'));await invoke(handler,event('evt_1'));assert.equal(runs.count,1);});
test('different events for one checkout session dispatch one paid RunPod job',async()=>{const store={},runs={count:0},handler=load(store,runs);await invoke(handler,event('evt_1'));await invoke(handler,event('evt_2'));assert.equal(runs.count,1);});
test('submitted and dispatch-unknown reservations never dispatch again',async()=>{for(const status of ['submitted','dispatch_unknown']){const store={[`mcs/orders/${ID}.json`]:{mcsJobId:ID,status,runpodJobId:status==='submitted'?'paid-job-1':''}},runs={count:0},handler=load(store,runs);const res=await invoke(handler,event('evt_'+status));assert.equal(runs.count,0);if(status==='dispatch_unknown')assert.equal(res.body.reconciliationRequired,true);else assert.equal(res.body.duplicate,true);}});
test('successful dispatch records the exact RunPod job ID',async()=>{const store={},runs={count:0},handler=load(store,runs);await invoke(handler,event('evt_1'));const order=store[`mcs/orders/${ID}.json`];assert.equal(order.status,'submitted');assert.equal(order.runpodJobId,'paid-job-1');assert.equal(order.runpodStatus,'IN_QUEUE');});
test('ambiguous dispatch failure is locked without a retry dispatch',async()=>{const store={},runs={count:0},handler=load(store,runs,{reject:true});const first=await invoke(handler,event('evt_1'));const second=await invoke(handler,event('evt_2'));assert.equal(first.body.reconciliationRequired,true);assert.equal(second.body.reconciliationRequired,true);assert.equal(store[`mcs/orders/${ID}.json`].status,'dispatch_unknown');assert.equal(runs.count,1);});
