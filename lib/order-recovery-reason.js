const TERMINAL_FAILURES=new Set(['FAILED','CANCELLED','TIMED_OUT']);
const ACTIVE=new Set(['IN_QUEUE','IN_PROGRESS']);
export const ORDER_RECOVERY_STALE_MS=35*60*1000;

export function orderRecoveryReason(job,latestProgress,now=Date.now(),providerHttp=200){
  if(Number(providerHttp)===404)return 'provider_missing';
  const status=String(job?.status||'').toUpperCase();
  const businessStatus=String(job?.output?.status||'').toLowerCase();
  if(businessStatus==='manual_review')return 'worker_manual_review';
  if(TERMINAL_FAILURES.has(status))return `terminal_${status.toLowerCase()}`;
  if(!ACTIVE.has(status))return '';
  const providerAge=status==='IN_QUEUE'?Number(job?.delayTime||0):Number(job?.executionTime||0);
  const silentAge=latestProgress?now-latestProgress:providerAge;
  return Math.max(providerAge,silentAge)>ORDER_RECOVERY_STALE_MS?`stuck_${status.toLowerCase()}`:'';
}
