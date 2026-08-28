const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

function loadRecoveryReason(){
  const filename=path.join(__dirname,'..','lib','order-recovery-reason.js');
  const source=fs.readFileSync(filename,'utf8')
    .replace('export const ORDER_RECOVERY_STALE_MS=', 'const ORDER_RECOVERY_STALE_MS=')
    .replace('export function orderRecoveryReason', 'function orderRecoveryReason')
    +'\nmodule.exports={ORDER_RECOVERY_STALE_MS,orderRecoveryReason};';
  const context={module:{exports:{}},Date,Set,Math,Number,String};
  vm.runInNewContext(source,context,{filename});
  return context.module.exports;
}

test('preserves shared paid-order manual-review recovery reason',async()=>{
  const api=loadRecoveryReason();
  assert.equal(api.orderRecoveryReason({status:'COMPLETED',output:{status:'manual_review'}},0),'worker_manual_review');
});

test('recovers hard failures and silent stalls but leaves healthy jobs alone',async()=>{
  const api=loadRecoveryReason();
  const now=50*60*1000;
  assert.equal(api.orderRecoveryReason({status:'FAILED'},0,now),'terminal_failed');
  assert.equal(api.orderRecoveryReason({status:'IN_PROGRESS',executionTime:36*60*1000},0,now),'stuck_in_progress');
  assert.equal(api.orderRecoveryReason({status:'IN_PROGRESS',executionTime:5*60*1000},now-60*1000,now),'');
  assert.equal(api.orderRecoveryReason({status:'COMPLETED',output:{status:'ready'}},0,now),'');
});
