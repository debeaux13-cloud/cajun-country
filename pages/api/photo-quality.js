import {getVercelOidcToken} from '@vercel/oidc';
import{issuePhotoPreviewEntitlement}from'../../lib/photo-entitlement';

const MAX_IMAGE_BYTES=4*1024*1024;
const PHOTO_STATUSES=new Set(['good','caution','retry_required']);
const RETRY_ISSUES=new Set(['severe_blur','near_black','blown_out','subject_too_small','subject_mostly_hidden','corrupted_or_unreadable','ui_obstruction','no_principal_subject']);

export const config={api:{bodyParser:{sizeLimit:'6mb'}}};

const qualitySchema={
  type:'object',
  additionalProperties:false,
  properties:{
    status:{type:'string',enum:['good','caution','retry_required']},
    blockingIssue:{type:'string',enum:['none',...RETRY_ISSUES]},
    reason:{type:'string'},
    tip:{type:'string'},
    visiblePrincipalSubjectCount:{type:'integer',minimum:0,maximum:12}
  },
  required:['status','blockingIssue','reason','tip','visiblePrincipalSubjectCount']
};

function firstHeader(value){return String(Array.isArray(value)?value[0]:value||'').split(',')[0].trim()}

export function assertSameOrigin(req,nodeEnv=process.env.NODE_ENV){
  if(nodeEnv!=='production')return;
  const host=firstHeader(req.headers?.['x-forwarded-host']||req.headers?.host).toLowerCase();
  const protocol=firstHeader(req.headers?.['x-forwarded-proto']||'https').toLowerCase();
  const origin=firstHeader(req.headers?.origin);
  const referer=firstHeader(req.headers?.referer);
  const fetchSite=firstHeader(req.headers?.['sec-fetch-site']).toLowerCase();
  if(!host||!['http','https'].includes(protocol))throw new Error('Unable to verify this photo check request.');
  if(fetchSite&&fetchSite!=='same-origin')throw new Error('Photo checks must start on this site.');
  let requestOrigin='';
  try{requestOrigin=origin?new URL(origin).origin:(referer?new URL(referer).origin:'')}catch{throw new Error('Unable to verify this photo check request.');}
  if(!requestOrigin||requestOrigin.toLowerCase()!==`${protocol}://${host}`)throw new Error('Photo checks must start on this site.');
}

function hasImageSignature(buffer,mime){
  if(mime==='image/jpeg')return buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(mime==='image/png')return buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(mime==='image/webp')return buffer.length>=12&&buffer.subarray(0,4).toString('ascii')==='RIFF'&&buffer.subarray(8,12).toString('ascii')==='WEBP';
  return false;
}

export function normalizePhotoDataUrl(value){
  const dataUrl=String(value||'').trim();
  const match=dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if(!match)throw new Error('Choose a JPEG, PNG, or WebP photo.');
  const mime=match[1].toLowerCase();
  const encoded=match[2];
  if(encoded.length%4!==0)throw new Error('That photo file could not be read.');
  const buffer=Buffer.from(encoded,'base64');
  if(!buffer.length||buffer.length>MAX_IMAGE_BYTES)throw new Error(buffer.length?'Choose a photo smaller than 4 MB.':'That photo file is empty.');
  if(buffer.toString('base64')!==encoded||!hasImageSignature(buffer,mime))throw new Error('That photo file looks damaged or unreadable.');
  return`data:${mime};base64,${encoded}`;
}

export function normalizeQualityResult(value){
  let status=PHOTO_STATUSES.has(value?.status)?value.status:'caution';
  const blockingIssue=String(value?.blockingIssue||'none');
  if(status==='retry_required'&&!RETRY_ISSUES.has(blockingIssue))status='caution';
  const visiblePrincipalSubjectCount=Math.max(0,Math.min(12,Number.isInteger(value?.visiblePrincipalSubjectCount)?value.visiblePrincipalSubjectCount:0));
  const reason=String(value?.reason||'The automatic photo check was inconclusive.').replace(/\s+/g,' ').trim().slice(0,240);
  const tip=String(value?.tip||'You may continue, or choose a clearer photo for the strongest likeness.').replace(/\s+/g,' ').trim().slice(0,240);
  return{status,reason,tip,visiblePrincipalSubjectCount};
}

function cautionFallback(){
  return{
    status:'caution',
    reason:'The automatic photo check is temporarily unavailable, so we did not block your photo.',
    tip:'You can continue. For the strongest likeness, make sure each main person or animal is recognizable.',
    visiblePrincipalSubjectCount:0
  };
}

async function gatewayToken(){
  if(process.env.AI_GATEWAY_API_KEY)return process.env.AI_GATEWAY_API_KEY;
  const oidc=await getVercelOidcToken();
  if(oidc)return oidc;
  throw new Error('Vercel AI Gateway auth missing');
}

async function inspectPhoto(image){
  const token=await gatewayToken();
  const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',
    signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify({
      model:'openai/gpt-4o-mini',
      max_completion_tokens:350,
      response_format:{type:'json_schema',json_schema:{name:'mcs_photo_usability',strict:true,schema:qualitySchema}},
      messages:[
        {role:'system',content:`You are a forgiving photo-usability checker for a personalized stylized 3D animated movie service. Judge only whether the visible principal people and animals provide enough identity information to make a reasonable character likeness. Count principal living people and animals, up to 12. Do not identify anyone, infer private traits, or demand professional photography.

Normal phone photos, screenshots of photos, spontaneous pictures of children or pets, imperfect lighting, ordinary cropping, busy backgrounds, mild blur, filters, non-front-facing poses, missing full bodies, and lack of eye contact are all acceptable. Studio quality, full bodies, eye contact, portrait framing, and perfect sharpness are never required.

Return "good" when the principal subjects are recognizable enough. Return "caution" when the photo remains usable but moderate blur, darkness, bright light, cropping, distance, obstruction, filters, or screenshot chrome may reduce likeness. A caution must still allow the customer to continue.

Return "retry_required" only when reliable identity is genuinely impossible because of exactly one blockingIssue: severe_blur; near_black; blown_out; subject_too_small; subject_mostly_hidden; corrupted_or_unreadable; ui_obstruction when screenshot/UI overlays cover defining features; or no_principal_subject. Never use retry_required for ordinary imperfections. If uncertain between caution and retry_required, choose caution.

Keep reason and tip warm, specific, concise, and non-technical. Never shame the photographer. Do not mention studio quality unless reassuring the customer that it is unnecessary.`},
        {role:'user',content:[{type:'text',text:'Check whether this everyday customer photo is usable. Be forgiving and block only when identity is genuinely unreadable.'},{type:'image_url',image_url:{url:image}}]}
      ]
    })
  });
  let payload;
  try{payload=await response.json()}catch{throw new Error('Photo checker returned an unreadable response');}
  if(!response.ok)throw new Error(payload?.error?.message||'Photo checker failed');
  let parsed;
  try{parsed=JSON.parse(String(payload?.choices?.[0]?.message?.content||''))}catch{throw new Error('Photo checker returned invalid JSON');}
  return normalizeQualityResult(parsed);
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  try{assertSameOrigin(req);}catch(error){return res.status(403).json({error:error.message});}
  let image;
  try{image=normalizePhotoDataUrl(req.body?.image);}catch(error){
    return res.status(400).json({status:'retry_required',reason:error.message,tip:'Try saving or choosing another clear copy of the photo.',visiblePrincipalSubjectCount:0});
  }
  let result;
  try{result=await inspectPhoto(image);}
  catch{result=cautionFallback();}
  if(result.status!=='retry_required'){
    try{result={...result,previewEntitlement:issuePhotoPreviewEntitlement(image)};}
    catch{return res.status(503).json({error:'The protected preview pass could not be prepared. Please try the photo again in a moment.'});}
  }
  return res.status(200).json(result);
}
