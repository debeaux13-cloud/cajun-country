export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  return res.status(410).json({error:'Worker patch route retired'});
}
