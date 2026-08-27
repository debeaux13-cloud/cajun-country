export default function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  return res.status(410).json({error:'V23 release control retired'});
}
