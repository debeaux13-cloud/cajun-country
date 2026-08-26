import{head}from'@vercel/blob';
export default async function handler(req,res){const token=process.env.BLOB_READ_WRITE_TOKEN;if(!token)return res.status(503).json({error:'Blob storage missing'});try{const sourceId='2674d1e7-fc7c-4636-b28c-5eb312f6d382';const meta=await head(`mcs/jobs/${sourceId}/reference.bin`,{token});const imageRes=await fetch(meta.downloadUrl||meta.url,{headers:{Authorization:`Bearer ${token}`}});if(!imageRes.ok)throw new Error(`Reference fetch failed ${imageRes.status}`);const bytes=Buffer.from(await imageRes.arrayBuffer());const contentType=meta.contentType||'image/jpeg';const image=`data:${contentType};base64,${bytes.toString('base64')}`;const plan=`1. Remi hears a frightened duckling crying near a busy city park entrance and immediately stops to investigate. She finds the tiny duckling hiding beside a bench while people and bicycles pass nearby.
2. Remi lowers herself gently, makes the duckling feel safe, and guides it away from the crowded path into a quieter flower garden.
3. Remi notices muddy webbed footprints and follows them with the duckling through the rose garden, searching for signs of the missing family.
4. A fast scooter suddenly cuts across the path. Remi jumps between it and the duckling, protects the little bird, and steers it safely onto the grass.
5. The trail reaches a shallow decorative stream. Remi carefully helps the duckling cross using stepping stones and her body for support, then discovers a loose feather on the far bank.
6. Remi hears distant quacking behind a closed water-garden gate. She pushes the gate open and holds it while the duckling hurries through, revealing a much bigger adventure ahead.
7. Inside the water gardens, the duckling races toward the wrong flock and Remi gently turns it back before everyone gets confused.
8. A bold crow swoops toward the duckling's snack crumbs, and Remi chases it away before continuing the search.
9. Remi tracks fresh webbed prints through tall reeds and muddy paths while the duckling follows closely behind.
10. A fallen branch blocks a narrow channel. Remi drags it aside so the duckling can paddle through safely.
11. The quacking grows louder near a lily pond, but the duck family is stranded across a gap of water.
12. Remi finds a narrow maintenance boardwalk and tests each plank before leading the duckling across.
13. One slippery board tips beneath the duckling. Remi drops low and catches the little bird against her foreleg before it falls.
14. They reach the far shore and push through tall reeds toward the waiting calls.
15. The duckling finally sees its family and rushes into the shallows while Remi hangs back, muddy and exhausted but proud.
16. The mother duck gathers the duckling close and the whole family waddles along the shoreline beside Remi.
17. One last duckling gets stuck between wet stones, and Remi gently frees it before the family continues together.
18. With everyone safe, Remi shakes off the mud, trots away through the glowing evening park, and carries one tiny feather on her nose like a ridiculous victory medal.`;const r=await fetch('https://main-character-studios.vercel.app/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,image,moods:['funny','dramatic']})});const j=await r.json();if(!r.ok)throw new Error(j?.error||'Preview dispatch failed');return res.status(200).json({ok:true,mcsJobId:j.mcsJobId,jobId:j.jobId,status:j.status,referenceBytes:bytes.length})}catch(e){return res.status(500).json({error:e.message})}}