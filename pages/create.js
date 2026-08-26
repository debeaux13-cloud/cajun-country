import {useRef,useState} from 'react';

const ACCEPTED_PHOTO_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const MAX_SOURCE_BYTES=25*1024*1024;
const MAX_READY_BYTES=3*1024*1024;
const MAX_SOURCE_PIXELS=60000000;
const VIBES=[
  {value:'surprise me',label:'Surprise Me'},
  {value:'funny',label:'Funny'},
  {value:'magical',label:'Magical'},
  {value:'adventure',label:'Adventure'},
  {value:'heartwarming',label:'Heartwarming'},
  {value:'mystery',label:'Mystery'},
  {value:'kid-safe spooky',label:'Kid-Safe Spooky'}
];

function canvasJpeg(canvas,quality){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('This browser could not prepare the photo.')),'image/jpeg',quality))}
function blobDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('The prepared photo could not be read.'));reader.readAsDataURL(blob)})}
function loadBrowserImage(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file);const image=new Image();image.onload=()=>resolve({image,url});image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('That photo could not be opened. Try a JPEG, PNG, or WebP image.'))};image.src=url})}
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

async function preparePhoto(file){
  if(!ACCEPTED_PHOTO_TYPES.has(file.type))throw new Error('Please choose a JPEG, PNG, WebP, HEIC, or HEIF photo.');
  if(file.size>MAX_SOURCE_BYTES)throw new Error('That photo is too large to prepare safely. Choose a clear photo under 25 MB.');
  const loaded=await loadBrowserImage(file);
  try{
    const sourceWidth=loaded.image.naturalWidth;
    const sourceHeight=loaded.image.naturalHeight;
    if(!sourceWidth||!sourceHeight)throw new Error('That photo has no readable dimensions.');
    if(sourceWidth>12000||sourceHeight>12000||sourceWidth*sourceHeight>MAX_SOURCE_PIXELS)throw new Error('That photo has unusually large dimensions. Choose a normal phone photo or screenshot instead.');
    for(const longestSide of [2048,1792,1536]){
      const scale=Math.min(1,longestSide/Math.max(sourceWidth,sourceHeight));
      const width=Math.max(1,Math.round(sourceWidth*scale));
      const height=Math.max(1,Math.round(sourceHeight*scale));
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d',{alpha:false});
      if(!context)throw new Error('This browser could not prepare the photo.');
      context.fillStyle='#ffffff';context.fillRect(0,0,width,height);context.drawImage(loaded.image,0,0,width,height);
      for(const quality of [.9,.82,.74,.66]){
        const ready=await canvasJpeg(canvas,quality);
        if(ready.size<=MAX_READY_BYTES)return blobDataUrl(ready);
      }
    }
    throw new Error('That photo still contains too much data. Try a simpler or smaller copy.');
  }finally{URL.revokeObjectURL(loaded.url)}
}

export default function Create(){
  const[idea,setIdea]=useState('');
  const[drafts,setDrafts]=useState([]);
  const[selectedDraftIndex,setSelectedDraftIndex]=useState(-1);
  const[draftsUsed,setDraftsUsed]=useState(0);
  const[status,setStatus]=useState('');
  const[image,setImage]=useState('');
  const[photoCheck,setPhotoCheck]=useState(null);
  const[checkingPhoto,setCheckingPhoto]=useState(false);
  const[vibe,setVibe]=useState('surprise me');
  const[busy,setBusy]=useState(false);
  const stageRequest=useRef(false);
  const previewRequest=useRef(false);

  const selectedDraft=selectedDraftIndex>=0?drafts[selectedDraftIndex]:null;

  function clearDraftContext(){setDrafts([]);setSelectedDraftIndex(-1)}
  const chooseVibe=next=>{if(next!==vibe){setVibe(next);if(drafts.length)setStatus('Vibe updated for your next draft. Your saved drafts are unchanged.')}};
  const changeIdea=value=>{setIdea(value);if(drafts.length)setStatus('Optional story text updated for your next draft. Your saved drafts are unchanged.')};
  const changeSelectedPlan=value=>setDrafts(current=>current.map((draft,index)=>index===selectedDraftIndex?{...draft,plan:value}:draft));

  async function stage(){
    if(stageRequest.current)return;
    if(draftsUsed>=3){setStatus('You have all 3 Stage drafts. Choose your favorite and edit it freely before starting your one moving preview.');return}
    if(!image){setStatus('Add the individual or group photo first so Stage can build the story around everyone in it.');return}
    if(checkingPhoto){setStatus('Give us a moment to finish checking that photo.');return}
    if(photoCheck?.status==='retry_required'){setStatus('Choose another photo before creating the story. The current photo does not show enough reliable identity detail.');return}
    const draftAttempt=draftsUsed+1;
    const priorStoryBriefs=drafts.map(draft=>draft.storyBrief).filter(Boolean);
    const priorSourceLedgers=drafts.map(draft=>draft.sourceLedger).filter(Boolean);
    const requestMode=idea.trim()?'my_story':'make_for_me';
    stageRequest.current=true;
    setBusy(true);
    setStatus(requestMode==='make_for_me'
      ?`Stage is creating text Draft ${draftAttempt} of 3 around everyone in your photo. No video or Runway credits are used.`
      :`Stage is creating text Draft ${draftAttempt} of 3 while preserving your facts and imagination. No video or Runway credits are used.`);
    try{
      const requestIdea=idea;
      const requestMoods=[vibe];
      const response=await fetch('/api/stage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({creativeMode:requestMode,idea:requestIdea,moods:requestMoods,image:image||undefined,draftAttempt,priorStoryBriefs,priorSourceLedgers})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Stage failed');
      const resolvedAttempt=Math.max(1,Math.min(3,Number(result.draftAttempt)||draftAttempt));
      const resolvedMode=result.creativeMode==='make_for_me'||result.creativeMode==='my_story'?result.creativeMode:requestMode;
      const draft={attempt:resolvedAttempt,title:result.title||`Draft ${resolvedAttempt}`,plan:result.plan,storyBrief:result.storyBrief??requestIdea,sourceLedger:result.sourceLedger??null,originalIdea:requestIdea,moods:requestMoods,creativeMode:resolvedMode};
      setDrafts(current=>[...current,draft]);
      setSelectedDraftIndex(drafts.length);
      setDraftsUsed(current=>Math.max(current,resolvedAttempt));
      setStatus(`Draft ${resolvedAttempt} of 3 is ready. Choose a favorite, edit anything you want, or try another text story before starting one moving preview.`);
    }catch(error){setStatus(error.message)}finally{stageRequest.current=false;setBusy(false)}
  }

  async function file(event){
    const selected=event.target.files?.[0];
    if(!selected)return;
    clearDraftContext();
    setDraftsUsed(0);
    setImage('');
    setPhotoCheck(null);
    setCheckingPhoto(true);
    setStatus('Preparing a clear, upload-safe copy of your photo…');
    try{
      const readyImage=await preparePhoto(selected);
      setImage(readyImage);
      setStatus('Checking whether the people and pets are clear enough to become characters…');
      try{
        const response=await fetch('/api/photo-quality',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:readyImage})});
        const result=await response.json();
        if(!response.ok&&result?.status!=='retry_required')throw new Error(result?.error||'Photo check failed');
        const resolved=['good','caution','retry_required'].includes(result?.status)?result:{status:'caution',reason:'The automatic photo check was inconclusive.',tip:'You can continue, or choose a clearer photo for the strongest likeness.',visiblePrincipalSubjectCount:0};
        setPhotoCheck(resolved);
        setStatus(resolved.status==='retry_required'?'Please choose another photo before creating the story.':'Photo ready. Every visible person and animal will be identified separately.');
      }catch{
        setPhotoCheck({status:'caution',reason:'The automatic photo check is temporarily unavailable, so we did not reject your picture.',tip:'You can still create and compare text stories. Upload the photo again before starting the protected moving preview.',visiblePrincipalSubjectCount:0,previewEntitlement:''});
        setStatus('Photo ready for text stories. Upload it again before starting the moving preview.');
      }
    }catch(error){event.target.value='';setStatus(error.message)}finally{setCheckingPhoto(false)}
  }

  async function preview(){
    if(previewRequest.current)return;
    if(!image){setStatus('Add one clear individual or group photo first.');return}
    if(!selectedDraft?.plan){setStatus('Choose or create a Stage draft first.');return}
    const previewEntitlement=String(photoCheck?.previewEntitlement||'');
    if(!previewEntitlement){setStatus('Upload the photo again so we can prepare its protected one-preview pass. Your text drafts will stay on this page.');return}
    previewRequest.current=true;
    setBusy(true);
    setStatus('Your chosen text draft is becoming its one free 60-second moving preview…');
    async function recoverAcceptedPreview(){
      for(let attempt=0;attempt<30;attempt++){
        if(attempt)await wait(3000);
        const response=await fetch('/api/preview?entitlement='+encodeURIComponent(previewEntitlement),{cache:'no-store'});
        let result={};try{result=await response.json();}catch{}
        if(response.status===200&&result.jobId&&result.mcsJobId)return result;
        if(response.status===202||response.status===404){setStatus('Your protected preview request is still being prepared…');continue}
        throw new Error(result.error||'The protected preview request could not be recovered.');
      }
      throw new Error('Your preview request is still being prepared. Wait a moment, then use the same preview button—do not create a second request.');
    }
    try{
      let response;
      try{response=await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previewEntitlement,creativeMode:selectedDraft.creativeMode,storyBrief:selectedDraft.storyBrief,sourceLedger:selectedDraft.sourceLedger,originalIdea:selectedDraft.originalIdea,plan:selectedDraft.plan,image,moods:selectedDraft.moods})})}catch{
        const recovered=await recoverAcceptedPreview();
        location.href='/preview?jobId='+encodeURIComponent(recovered.jobId)+'&mcsJobId='+encodeURIComponent(recovered.mcsJobId);
        return;
      }
      let result={};try{result=await response.json();}catch{}
      if(!response.ok)throw new Error(result.error||'Preview failed');
      if(response.status===202||!result.jobId)result=await recoverAcceptedPreview();
      location.href='/preview?jobId='+encodeURIComponent(result.jobId)+'&mcsJobId='+encodeURIComponent(result.mcsJobId);
    }catch(error){previewRequest.current=false;setStatus(error.message);setBusy(false)}
  }

  return <main style={{minHeight:'100vh',background:'#120f18',color:'#fff',fontFamily:'Arial,sans-serif'}}>
    <div style={{maxWidth:980,margin:'0 auto',padding:20}}>
      <header style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}>
        <a href='/' style={{color:'#fff'}}>← Main Character Studios by Tiffani</a>
        <a href='/my-orders' style={{color:'#fff',fontWeight:900}}>My Orders</a>
      </header>
      <div style={{marginTop:26,padding:'10px 14px',display:'inline-flex',gap:12,alignItems:'center',borderRadius:999,background:'#24182f',border:'1px solid #5c4470'}}><span>3-minute movie</span><strong>$49</strong></div>
      <h1 style={{fontFamily:'Georgia,serif',fontSize:'clamp(40px,7vw,70px)',marginBottom:8}}>Make them the main character.</h1>
      <p style={{fontSize:18,opacity:.85}}>AI Story Chat included · 3-minute personalized moving movie · first 60 seconds free</p>
      <section style={{marginTop:24,background:'#19121f',border:'1px solid #3d2d49',borderRadius:24,padding:20}}>
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:14}}><div style={{width:42,height:42,borderRadius:99,background:'#7b2cff',display:'grid',placeItems:'center',fontWeight:900}}>AI</div><div><b>STAGE · YOUR AI STORY PARTNER · INCLUDED</b><div style={{opacity:.7}}>Add a photo, choose one vibe, and optionally share anything from a tiny idea to a whole story. Stage writing uses no video credits.</div></div></div>

        <div style={{margin:'18px 0'}}>
          <label style={{display:'block',fontWeight:800,marginBottom:8}}>Add one clear photo of the person, pet, family, or group starring in the movie</label>
          <div style={{fontSize:14,opacity:.72,marginBottom:8}}>Group photos are welcome. Up to 12 people and animals can be identified separately. Everyday phone pictures and screenshots are welcome—no studio setup, full-body pose, or eye contact required.</div>
          <div role='note' style={{fontSize:14,fontWeight:800,lineHeight:1.45,margin:'10px 0',padding:'11px 13px',borderRadius:12,color:'#fff4cf',background:'#4a3512',border:'1px solid #d6a33b'}}>Photo quality matters: AI can only preserve features it can clearly see. Blurry, dark, cropped, distant/tiny, or obstructed people and pets may not match, so choose a clearer photo before continuing.</div>
          <input type='file' disabled={busy||checkingPhoto} accept='image/jpeg,image/png,image/webp,image/heic,image/heif' onChange={file}/>{checkingPhoto&&<span style={{marginLeft:10}}>Checking photo…</span>}{image&&!checkingPhoto&&<span style={{marginLeft:10}}>✓ photo prepared</span>}
          {photoCheck&&<div role={photoCheck.status==='retry_required'?'alert':'status'} style={{marginTop:12,padding:'12px 14px',borderRadius:14,lineHeight:1.45,border:`1px solid ${photoCheck.status==='good'?'#4cc38a':photoCheck.status==='caution'?'#d6a33b':'#ff6b6b'}`,background:photoCheck.status==='good'?'#153d2b':photoCheck.status==='caution'?'#4a3512':'#4a1d25'}}><strong>{photoCheck.status==='good'?'✓ This photo is usable':photoCheck.status==='caution'?'This photo is usable—with a heads-up':'Please try another photo'}</strong>{photoCheck.visiblePrincipalSubjectCount>0&&<span> · {photoCheck.visiblePrincipalSubjectCount} principal {photoCheck.visiblePrincipalSubjectCount===1?'subject':'subjects'} visible</span>}<div>{photoCheck.reason}</div><div style={{opacity:.82}}>{photoCheck.tip}</div></div>}
        </div>

        <fieldset disabled={busy} style={{border:0,padding:0,margin:'18px 0'}}><legend style={{fontWeight:800,marginBottom:8}}>Choose one vibe</legend><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{VIBES.map(option=><button type='button' key={option.value} aria-pressed={vibe===option.value} onClick={()=>chooseVibe(option.value)} style={{padding:'9px 13px',borderRadius:999,fontWeight:800,background:vibe===option.value?'#7b2cff':'#2b2135',color:'#fff',border:vibe===option.value?'2px solid #b994ff':'1px solid #5c4470'}}>{option.label}</button>)}</div></fieldset>

        <label htmlFor='story-input' style={{display:'block',fontWeight:800,marginBottom:8}}>Optional: add an idea or paste a whole story</label>
        <textarea id='story-input' disabled={busy} value={idea} onChange={event=>changeIdea(event.target.value)} placeholder='Leave blank and Stage will invent it, type a short theme, paste messy kid writing, or add your complete story.' style={{width:'100%',minHeight:130,padding:15,borderRadius:16,background:'#0f0b13',color:'#fff',boxSizing:'border-box',fontSize:16}}/>

        {!drafts.length&&draftsUsed<3&&<button disabled={busy||checkingPhoto||photoCheck?.status==='retry_required'} onClick={stage} style={{marginTop:14,padding:'13px 20px',borderRadius:999,fontWeight:900}}>{busy?'Creating Draft…':checkingPhoto?'Checking Photo…':'Create My Story'}</button>}
        <p style={{minHeight:24}}>{status}</p>
        {!drafts.length&&draftsUsed>=3&&<p style={{padding:12,borderRadius:12,background:'#2b2135'}}>All 3 Stage text drafts have been used in this page session.</p>}
        {selectedDraft&&<>
          <h3>Choose your favorite Stage draft</h3>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>{drafts.map((draft,index)=><button type='button' disabled={busy} key={`${draft.attempt}-${index}`} onClick={()=>setSelectedDraftIndex(index)} aria-pressed={index===selectedDraftIndex} style={{padding:'9px 13px',borderRadius:999,fontWeight:800,color:'#fff',background:index===selectedDraftIndex?'#7b2cff':'#2b2135',border:'1px solid #5c4470'}}>Draft {draft.attempt}/3</button>)}</div>
          <h3>Draft {selectedDraft.attempt}/3 · Your editable 3-minute plan</h3>
          <p style={{opacity:.78}}>Make it yours before previewing. For example: “change the horse to a unicorn,” rewrite dialogue, or adjust any event.</p>
          <textarea disabled={busy} value={selectedDraft.plan} onChange={event=>changeSelectedPlan(event.target.value)} style={{width:'100%',minHeight:360,padding:14,borderRadius:16,background:'#0f0b13',color:'#fff',boxSizing:'border-box'}}/>
          {draftsUsed<3&&<button disabled={busy} onClick={stage} style={{marginTop:12,padding:'12px 18px',borderRadius:999,fontWeight:900}}>{busy?'Writing another text draft…':'Try another story'}</button>}
          {draftsUsed>=3&&<p style={{opacity:.76}}>You have all 3 text drafts. Select the one you like best and edit it as much as you want.</p>}
          <p style={{opacity:.72}}>These three choices are text-only and use no video or Runway credits. Your selected draft gets one free moving 60-second preview; after payment, that same story continues through scenes 7–18.</p>
          <button disabled={busy||!photoCheck?.previewEntitlement} onClick={preview} style={{marginTop:8,padding:'15px 22px',borderRadius:999,fontWeight:900}}>Make my one free moving preview →</button>
        </>}
      </section>
    </div>
  </main>
}
