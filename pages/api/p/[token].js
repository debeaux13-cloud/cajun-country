import {getSavedPreviewByShare,sharedPreview,storedMovieAvailable} from '../../../lib/saved-previews';
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const blobToken=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!blobToken)return res.status(503).json({error:'Preview storage unavailable'});
  try{const preview=await getSavedPreviewByShare(req.query?.token,blobToken);if(!preview||!await storedMovieAvailable(preview,blobToken))return res.status(404).json({error:'Preview is unavailable'});return res.status(200).json({preview:sharedPreview(preview)});}catch(error){return res.status(502).json({error:error.message});}
}
