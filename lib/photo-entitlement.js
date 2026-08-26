import crypto from 'crypto';

const TOKEN_PATTERN=/^mcs1\.(\d{4}-\d{2}-\d{2})\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/;

function entitlementSecret(){
  const secret=String(process.env.PREVIEW_ENTITLEMENT_SECRET||process.env.MCS_WORKER_SECRET||process.env.BLOB_READ_WRITE_TOKEN||'').trim();
  if(secret.length<24)throw new Error('Preview entitlement protection is unavailable');
  return secret;
}

function dayOffset(days){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

function imageDigest(dataUrl){
  const encoded=String(dataUrl||'').split(',',2)[1]||'';
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length)throw new Error('Photo entitlement requires a readable photo');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function signature(day,digest){
  return crypto.createHmac('sha256',entitlementSecret()).update('mcs-preview-entitlement\0').update(day).update('\0').update(digest).digest('base64url');
}

function safeEqual(left,right){
  const a=Buffer.from(String(left||''));
  const b=Buffer.from(String(right||''));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

function parseAndVerify(value){
  const token=String(value||'').trim();
  const match=token.match(TOKEN_PATTERN);
  if(!match)throw new Error('A valid photo preview entitlement is required');
  const[,day,digest,suppliedSignature]=match;
  if(![dayOffset(0),dayOffset(-1)].includes(day))throw new Error('This photo preview entitlement has expired. Upload the photo again.');
  if(!safeEqual(suppliedSignature,signature(day,digest)))throw new Error('This photo preview entitlement is invalid');
  return{token,day,digest};
}

function requestIdForToken(token){
  const bytes=crypto.createHash('sha256').update('mcs-preview-claim\0').update(token).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function issuePhotoPreviewEntitlement(dataUrl){
  const day=dayOffset(0);
  const digest=imageDigest(dataUrl);
  return`mcs1.${day}.${digest}.${signature(day,digest)}`;
}

export function previewRequestIdFromEntitlement(value){
  return requestIdForToken(parseAndVerify(value).token);
}

export function verifyPhotoPreviewEntitlement(value,dataUrl){
  const verified=parseAndVerify(value);
  if(!safeEqual(verified.digest,imageDigest(dataUrl)))throw new Error('This preview entitlement belongs to a different photo. Upload the photo again.');
  return requestIdForToken(verified.token);
}
