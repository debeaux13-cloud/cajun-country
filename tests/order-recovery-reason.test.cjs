const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

async function loadRecoveryReason(){
  const filename=path.join(__dirname,'..','lib','order-recovery-reason.js');
  const context=vm.createContext({Date,Set});
  const module=new vm.SourceTextModule(fs.readFileSync(filename,'utf8'),{context,identifier:filename});
  await module.link(()=>{throw new Error('Recovery reason must not import external services')});
  await module.evaluate();
  return module.namespace;
}

test('automatically recovers a completed worker that requests manual review',async()=>{
  const api=await loadRecoveryReason();
  assert.equal(api.orderRecoveryReason({status:'COMPLETED',output:{status:'manual_review'}},0),'worker_manual_review');
});

test('recovers hard failures and silent stalls but leaves healthy jobs alone',async()=>{
  const api=await loadRecoveryReason();
  const now=50*60*1000;
  assert.equal(api.orderRecoveryReason({status:'FAILED'},0,now),'terminal_failed');
  assert.equal(api.orderRecoveryReason({status:'IN_PROGRESS',executionTime:36*60*1000},0,now),'stuck_in_progress');
  assert.equal(api.orderRecoveryReason({status:'IN_PROGRESS',executionTime:5*60*1000},now-60*1000,now),'');
  assert.equal(api.orderRecoveryReason({status:'COMPLETED',output:{status:'ready'}},0,now),'');
});
