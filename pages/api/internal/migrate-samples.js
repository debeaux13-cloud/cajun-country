import{BlobNotFoundError,head,put}from'@vercel/blob';

const OLD='https://main-characters-studios-by-tiffani-pdipwyen2.vercel.app';
const FILES=[
  {name:'mayaMovie',source:'/sample-pack/maya-secret-door-animated-story.mp4',dest:'mcs/samples/maya-secret-door-animated-story.mp4',type:'video/mp4',min:100000},
  {name:'mayaCover',source:'/story-assets/maya-cover-wide.jpg',dest:'mcs/samples/maya-cover.jpg',type:'image/jpeg',min:1000},
  {name:'remiCover',source:'/story-assets/remi-cover.jpg',dest:'mcs/samples/remi-cover.jpg',type:'image/jpeg',min:1000},
  {name:'remiBook',source:'/sample-pack/remi-sun-finds-remi-sample-storybook.pdf',dest:'mcs/samples/remi-sun-finds-remi-sample-storybook.pdf',type:'application/pdf',min:1000}
];

async function exists(pathname,token){try{const meta=await head(pathname,{token});return Number(meta.size)>0?meta:null}catch(error){if(error instanceof BlobNotFoundError)return null;return null}}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(process.env.VERCEL_ENV!=='preview')return res.status(404).json({error:'Not found'});
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const token=process.env.BLOB_READ_WRITE_TOKEN||'';
  if(!token)return res.status(503).json({error:'Blob storage unavailable'});
  const results=[];
  try{
    for(const file of FILES){
      const prior=await exists(file.dest,token);
      if(prior&&Number(prior.size)>=file.min){results.push({name:file.name,status:'already_present',size:Number(prior.size)});continue}
      const response=await fetch(OLD+file.source,{cache:'no-store'});
      if(!response.ok)throw new Error(`${file.name} source returned ${response.status}`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<file.min)throw new Error(`${file.name} source was incomplete (${bytes.length} bytes)`);
      await put(file.dest,bytes,{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:file.type,token});
      results.push({name:file.name,status:'copied',size:bytes.length});
    }
    return res.status(200).json({ok:true,results});
  }catch(error){return res.status(502).json({ok:false,error:String(error?.message||error),results})}
}
