import crypto from 'crypto';
import {head,put} from '@vercel/blob';

const EXPECTED_TOKEN_HASH='3713254dbc9e1bdb8f13878bb839912abe5c180010159562eec55a93ce268832';
const SECRET_PATH='mcs/config/stripe-test-webhook-secret.json';

function safeEqualHex(a,b){
  try{
    const left=Buffer.from(String(a),'hex');
    const right=Buffer.from(String(b),'hex');
    return left.length===right.length&&crypto.timingSafeEqual(left,right);
  }catch{return false}
}

async function exists(token){
  try{await head(SECRET_PATH,{token});return true}catch{return false}
}

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'POST only'});
  const supplied=String(req.headers['x-mcs-bootstrap-token']||'');
  const suppliedHash=crypto.createHash('sha256').update(supplied).digest('hex');
  if(!safeEqualHex(suppliedHash,EXPECTED_TOKEN_HASH))return res.status(401).json({error:'Unauthorized'});

  const secret=String(req.body?.secret||'').trim();
  const endpointId=String(req.body?.endpointId||'').trim();
  if(!/^whsec_[A-Za-z0-9]+$/.test(secret))return res.status(400).json({error:'Invalid webhook secret'});
  if(!/^we_[A-Za-z0-9]+$/.test(endpointId))return res.status(400).json({error:'Invalid endpoint id'});

  const token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!token)return res.status(503).json({error:'Blob storage missing'});
  if(await exists(token))return res.status(409).json({error:'Already configured'});

  await put(SECRET_PATH,JSON.stringify({secret,endpointId,createdAt:new Date().toISOString()}),{
    access:'private',
    addRandomSuffix:false,
    allowOverwrite:false,
    token,
    contentType:'application/json'
  });
  return res.status(201).json({ok:true,stored:true,endpointId});
}
