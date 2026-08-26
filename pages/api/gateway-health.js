import { getVercelOidcToken } from '@vercel/oidc';

export default async function handler(req,res){
  const hasApiKey=!!process.env.AI_GATEWAY_API_KEY;
  let oidcPresent=false;
  if(!hasApiKey){
    try{ oidcPresent=!!(await getVercelOidcToken()); }catch{}
  }
  const ok=hasApiKey||oidcPresent;
  res.status(ok?200:503).json({
    ok,
    provider:'vercel-ai-gateway',
    auth:hasApiKey?'api-key':oidcPresent?'oidc':'missing',
    apiKeyPresent:hasApiKey,
    oidcPresent
  });
}
