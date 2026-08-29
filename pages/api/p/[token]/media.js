import {head,issueSignedToken,presignUrl} from '@vercel/blob';
import {getSavedPreviewByShare,storedMovieAvailable,moviePath,storybookPath} from '../../../../lib/saved-previews';
export default async function handler(req,res){
  const blobToken=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!blobToken)return res.status(503).json({error:'Preview storage unavailable'});
  try{const preview=await getSavedPreviewByShare(req.query?.token,blobToken);if(!preview||!await storedMovieAvailable(preview,blobToken))return res.status(404).json({error:'Preview is unavailable'});const book=String(req.query?.kind||'')==='storybook';const pathname=book?storybookPath(preview.mcsJobId):moviePath(preview.mcsJobId);if(book){const meta=await head(pathname,{token:blobToken});if(meta.contentType!=='application/pdf'||Number(meta.size)<=1024)return res.status(404).json({error:'Preview storybook is unavailable'});}
  const token=await issueSignedToken({pathname,operations:['get'],validUntil:Date.now()+60*60*1000});const {presignedUrl}=await presignUrl(token,{operation:'get',pathname,access:'private',validUntil:Date.now()+30*60*1000});res.setHeader('Cache-Control','private, no-store');return res.redirect(302,presignedUrl);}catch(error){return res.status(404).json({error:'Preview is unavailable'});}}
