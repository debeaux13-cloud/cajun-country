import {useRef,useState} from 'react';

const ACCEPTED_PHOTO_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const MAX_SOURCE_BYTES=25*1024*1024;
const MAX_READY_BYTES=3*1024*1024;
const MAX_SOURCE_PIXELS=60000000;
const VIBES=[
  {value:'funny',label:'Funny'},
  {value:'silly',label:'Silly'},
  {value:'dramatic',label:'Dramatic'},
  {value:'spooky',label:'Spooky'},
  {value:'romantic',label:'Romantic'}
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
  const[chatInput,setChatInput]=useState('');
  const[chatMessages,setChatMessages]=useState([]);
  const[chatBusy,setChatBusy]=useState(false);
  const[needsClarification,setNeedsClarification]=useState(false);
  const[drafts,setDrafts]=useState([]);
  const[selectedDraftIndex,setSelectedDraftIndex]=useState(-1);
  const[draftsUsed,setDraftsUsed]=useState(0);
  const[status,setStatus]=useState('');
  const[image,setImage]=useState('');
  const[photoCheck,setPhotoCheck]=useState(null);
  const[checkingPhoto,setCheckingPhoto]=useState(false);
  const[vibe,setVibe]=useState('');
  const[busy,setBusy]=useState(false);
  const stageRequest=useRef(false);
  const previewRequest=useRef(false);

  const selectedDraft=selectedDraftIndex>=0?drafts[selectedDraftIndex]:null;

  function clearDraftContext(){setDrafts([]);setSelectedDraftIndex(-1)}
  const chooseVibe=next=>{if(next!==vibe){setVibe(next);if(drafts.length)setStatus('Vibe updated for your next draft. Your saved drafts are unchanged.')}};
  const changeIdea=value=>{setIdea(value);if(drafts.length)setStatus('Story direction updated for your next draft. Your saved draft is unchanged.')};
  const changeSelectedPlan=value=>setDrafts(current=>current.map((draft,index)=>index===selectedDraftIndex?{...draft,plan:value,storyBrief:value,originalIdea:value,creativeMode:'my_story'}:draft));

  async function talkToStage(message=chatInput,imageOverride=image,historyOverride=chatMessages){
    const text=String(message||'').trim();
    if(!imageOverride){setStatus('Upload the starring photo before chatting with Stage.');return}
    if(chatBusy)return;
    const history=Array.isArray(historyOverride)?historyOverride:[];
    if(text)setChatMessages(current=>[...current,{role:'user',content:text}]);
    setChatInput('');setChatBusy(true);
    try{
      const response=await fetch('/api/story-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,image:imageOverride,vibe,history})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Stage chat failed');
      setChatMessages(current=>[...current,{role:'assistant',content:result.reply}]);
      setNeedsClarification(Boolean(result.clarificationNeeded));
      if(text)changeIdea([idea,text].filter(Boolean).join('\n'));
      setStatus(result.clarificationNeeded?'Answer Stage’s one question, then create your story.':'Stage understands the photo and is ready to create your story.');
    }catch(error){setNeedsClarification(false);setStatus(error.message)}finally{setChatBusy(false)}
  }

  async function stage(){
    if(stageRequest.current)return;
    if(!image){setStatus('Add the individual or group photo first so Stage can build the story around everyone in it.');return}
    const completeIdea=[idea,chatInput].map(value=>String(value||'').trim()).filter(Boolean).join('\n');
    if(!completeIdea&&!vibe){setStatus('Choose a story type or tell the AI your own idea before continuing.');return}
    if(needsClarification){setStatus('Answer Stage’s question in the AI chat before creating the story.');return}
    if(checkingPhoto){setStatus('Give us a moment to finish checking that photo.');return}
    if(photoCheck?.status==='retry_required'){setStatus('Choose another photo before creating the story. The current photo does not show enough reliable identity detail.');return}
    const draftAttempt=Math.min(3,draftsUsed+1);
    const priorStoryBriefs=drafts.map(draft=>draft.storyBrief).filter(Boolean);
    const priorSourceLedgers=drafts.map(draft=>draft.sourceLedger).filter(Boolean);
    const requestMode=completeIdea?'my_story':'make_for_me';
    stageRequest.current=true;
    setBusy(true);
    setStatus(requestMode==='make_for_me'?'Inventing one complete story around everyone in your photo…':'Turning your idea into one complete story…');
    try{
      const requestIdea=completeIdea;
      if(chatInput.trim()){setIdea(completeIdea);setChatInput('')}
      const requestMoods=[vibe||'surprise me'];
      const response=await fetch('/api/stage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({creativeMode:requestMode,idea:requestIdea,moods:requestMoods,image:image||undefined,draftAttempt,priorStoryBriefs,priorSourceLedgers})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Stage failed');
      const resolvedAttempt=Math.max(1,Math.min(3,Number(result.draftAttempt)||draftAttempt));
      const resolvedMode=result.creativeMode==='make_for_me'||result.creativeMode==='my_story'?result.creativeMode:requestMode;
      const draft={attempt:resolvedAttempt,title:result.title||`Draft ${resolvedAttempt}`,plan:result.plan,storyBrief:result.storyBrief??requestIdea,sourceLedger:result.sourceLedger??null,originalIdea:requestIdea,moods:requestMoods,creativeMode:resolvedMode};
      setDrafts([draft]);
      setSelectedDraftIndex(0);
      setDraftsUsed(current=>Math.max(current,resolvedAttempt));
      setStatus('Your story is ready. Change anything you want, then preview it.');
    }catch(error){setStatus(error.message)}finally{stageRequest.current=false;setBusy(false)}
  }

  async function file(event){
    const selected=event.target.files?.[0];
    if(!selected)return;
    clearDraftContext();
    setDraftsUsed(0);
    setImage('');
    setPhotoCheck(null);
    setChatMessages([]);setChatInput('');setNeedsClarification(false);
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
        setStatus(resolved.status==='retry_required'?'Please choose another photo before creating the story.':'Photo ready. Stage is looking at everyone in it now…');
        if(resolved.status!=='retry_required')void talkToStage('',readyImage,[]);
      }catch{
        setPhotoCheck({status:'caution',reason:'The automatic photo check is temporarily unavailable, so we did not reject your picture.',tip:'You can still create and compare text stories. Upload the photo again before starting the protected moving preview.',visiblePrincipalSubjectCount:0,previewEntitlement:''});
        setStatus('Photo ready for text stories. Stage is looking at everyone in it now…');
        void talkToStage('',readyImage,[]);
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
    setStatus('Your chosen text draft is becoming its one free 1-minute moving preview…');
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
        const previewUrl='/preview?jobId='+encodeURIComponent(recovered.jobId)+'&mcsJobId='+encodeURIComponent(recovered.mcsJobId);
        window.localStorage.setItem('mcs-latest-preview',JSON.stringify({url:previewUrl,title:selectedDraft?.title||'Your free movie preview',createdAt:Date.now()}));
        location.href=previewUrl;
        return;
      }
      let result={};try{result=await response.json();}catch{}
      if(!response.ok)throw new Error(result.error||'Preview failed');
      if(response.status===202||!result.jobId)result=await recoverAcceptedPreview();
      const previewUrl='/preview?jobId='+encodeURIComponent(result.jobId)+'&mcsJobId='+encodeURIComponent(result.mcsJobId);
      window.localStorage.setItem('mcs-latest-preview',JSON.stringify({url:previewUrl,title:selectedDraft?.title||'Your free movie preview',createdAt:Date.now()}));
      location.href=previewUrl;
    }catch(error){previewRequest.current=false;setStatus(error.message);setBusy(false)}
  }

  return <main className='createPage' style={{minHeight:'100vh',background:'#120f18',color:'#fff',fontFamily:'Arial,sans-serif'}}>
    <div className='createShell' style={{maxWidth:980,margin:'0 auto',padding:20}}>
      <header className='createHeader' style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}>
        <a href='/' style={{color:'#fff'}}>← Main Character Studios by Tiffani</a>
        <a href='/my-orders' style={{color:'#fff',fontWeight:900}}>My Orders</a>
      </header>
      <div className='pricePill' style={{marginTop:26,padding:'10px 14px',display:'inline-flex',gap:12,alignItems:'center',borderRadius:999,background:'#24182f',border:'1px solid #5c4470'}}><span>3-minute movie</span><strong>$49</strong></div>
      <h1 className='createTitle' style={{fontFamily:'Georgia,serif',fontSize:'clamp(40px,7vw,70px)',marginBottom:8}}>Make them the main character.</h1>
      <p className='createSubtitle' style={{fontSize:18,opacity:.85}}>AI Story Chat included · 3-minute personalized moving movie · first minute free</p>
      <section className='createCard' style={{marginTop:24,background:'#19121f',border:'1px solid #3d2d49',borderRadius:24,padding:20}}>
        <div className='stageIntro' style={{display:'flex',gap:12,alignItems:'center',marginBottom:14}}><div className='aiBadge' style={{width:42,height:42,borderRadius:99,background:'#7b2cff',display:'grid',placeItems:'center',fontWeight:900}}>AI</div><div><b>START HERE · AI STORY CHAT</b><div style={{opacity:.7}}>Upload a photo, then choose the kind of story you want—or tell the AI your own idea in the black box.</div></div></div>
        {busy&&<div className='workingToast' role='status' aria-live='polite'><span className='workingSpinner'/><span>{status||'Creating your story…'}</span></div>}

        <div style={{margin:'18px 0'}}>
          <label style={{display:'block',fontWeight:800,marginBottom:8}}>Add one clear photo of the person, pet, family, or group starring in the movie</label>
          <div style={{fontSize:14,opacity:.72,marginBottom:8}}>Group photos are welcome. Up to 12 people and animals can be identified separately. Everyday phone pictures and screenshots are welcome—no studio setup, full-body pose, or eye contact required.</div>
          <div className='photoNote' role='note' style={{fontSize:14,fontWeight:800,lineHeight:1.45,margin:'10px 0',padding:'11px 13px',borderRadius:12,color:'#fff4cf',background:'#4a3512',border:'1px solid #d6a33b'}}>Photo quality matters: AI can only preserve features it can clearly see. Blurry, dark, cropped, distant/tiny, or obstructed people and pets may not match, so choose a clearer photo before continuing.</div>
          <input className='photoInput' type='file' disabled={busy||checkingPhoto} accept='image/jpeg,image/png,image/webp,image/heic,image/heif' onChange={file}/>{checkingPhoto&&<span style={{marginLeft:10}}>Checking photo…</span>}{image&&!checkingPhoto&&<span style={{marginLeft:10}}>✓ photo prepared</span>}
          {photoCheck&&<div className='photoResult' role={photoCheck.status==='retry_required'?'alert':'status'} style={{marginTop:12,padding:'12px 14px',borderRadius:14,lineHeight:1.45,border:`1px solid ${photoCheck.status==='good'?'#4cc38a':photoCheck.status==='caution'?'#d6a33b':'#ff6b6b'}`,background:photoCheck.status==='good'?'#153d2b':photoCheck.status==='caution'?'#4a3512':'#4a1d25'}}><strong>{photoCheck.status==='good'?'✓ This photo is usable':photoCheck.status==='caution'?'This photo is usable—with a heads-up':'Please try another photo'}</strong>{photoCheck.visiblePrincipalSubjectCount>0&&<span> · {photoCheck.visiblePrincipalSubjectCount} principal {photoCheck.visiblePrincipalSubjectCount===1?'subject':'subjects'} visible</span>}<div>{photoCheck.reason}</div><div style={{opacity:.82}}>{photoCheck.tip}</div></div>}
        </div>

        <fieldset className='vibePicker' disabled={busy} style={{border:0,padding:0,margin:'18px 0'}}><legend style={{fontWeight:800,marginBottom:8}}>Do you want me to tell you a…</legend><div className='vibeButtons' style={{display:'flex',gap:8,flexWrap:'wrap'}}>{VIBES.map(option=><button className='vibeButton' type='button' key={option.value} aria-pressed={vibe===option.value} onClick={()=>chooseVibe(option.value)} style={{padding:'9px 13px',borderRadius:999,fontWeight:800,background:vibe===option.value?'#7b2cff':'#2b2135',color:'#fff',border:vibe===option.value?'2px solid #b994ff':'1px solid #5c4470'}}>{option.label}</button>)}</div></fieldset>

        {!selectedDraft&&<>
          <section className='storyChatPanel' aria-label='AI Story Chat'>
            <div className='chatTitle'>STAGE · AI STORY CHAT</div>
            <div className='chatMessages' aria-live='polite'>
              {chatMessages.length?chatMessages.map((item,index)=><div key={index} className={item.role==='assistant'?'chatBubble assistantBubble':'chatBubble userBubble'}>{item.content}</div>):<div className='chatBubble assistantBubble'>Upload the starring photo. I’ll tell you who I see and ask one useful question only if I need it.</div>}
              {chatBusy&&<div className='chatBubble assistantBubble'>Stage is looking and thinking…</div>}
            </div>
            <label htmlFor='story-input' className='typeHereLabel'>TYPE YOUR MESSAGE HERE</label>
            <textarea className='storyInput chatInput' id='story-input' disabled={busy||chatBusy} value={chatInput} onChange={event=>setChatInput(event.target.value)} placeholder='Tell Stage who everyone is, answer its question, or type your own story idea.'/>
            <button className='sendChatButton' type='button' disabled={busy||chatBusy||!chatInput.trim()||!image} onClick={()=>talkToStage()}>Send to Stage</button>
          </section>
          <button className='primaryButton' disabled={busy||chatBusy||checkingPhoto||needsClarification||photoCheck?.status==='retry_required'||(!idea.trim()&&!chatInput.trim()&&!vibe)} onClick={stage} style={{marginTop:14,padding:'13px 20px',borderRadius:999,fontWeight:900}}>{busy?'Creating your story…':checkingPhoto?'Checking Photo…':'Create My Story'}</button>
        </>}
        <p className='statusLine' style={{minHeight:24}}>{status}</p>
        {selectedDraft&&<>
          <div className='storyHeading'>
            <div>
              <div className='optionLabel'>YOUR STORY</div>
              <h2>{selectedDraft.title||'Your Main Character Story'}</h2>
            </div>
          </div>
          <p className='editHelp'>Read it, change anything you want directly in the box, then preview it. For example: “change the horse to a unicorn.”</p>
          <textarea className='storyInput customerStory' disabled={busy} value={selectedDraft.storyBrief||selectedDraft.plan} onChange={event=>changeSelectedPlan(event.target.value)} style={{width:'100%',minHeight:280,padding:18,borderRadius:18,boxSizing:'border-box',fontSize:17}}/>
          <div className='storyActions'>
            {draftsUsed<3&&<button className='secondaryButton' disabled={busy} onClick={stage}>{busy?'Writing a different story…':'Make a different story'}</button>}
            <button className='previewButton' disabled={busy||!photoCheck?.previewEntitlement} onClick={preview}>Preview My Movie Free →</button>
          </div>
          <p className='simplePreviewCopy'>Watch the first minute. Love it? Buy the full 3-minute movie and matching storybook PDF. Want a change? Edit this story before previewing.</p>
        </>}
      </section>
    </div>
    <style jsx global>{`
      *{box-sizing:border-box}
      html,body{margin:0;max-width:100%;overflow-x:hidden}
      .createPage{background:#fbf1ea!important;color:#24152e!important}
      .createShell{padding:24px!important}
      .createHeader a{color:#5b267d!important;font-weight:800;text-decoration:none}
      .pricePill{background:#fff!important;border:1px solid #eadbe9!important;box-shadow:0 10px 28px rgba(61,35,73,.08)}
      .createTitle{line-height:1!important;letter-spacing:-1.5px}
      .createSubtitle{color:#6f6378!important;opacity:1!important}
      .createCard{background:#fff!important;border:1px solid #eadbe9!important;box-shadow:0 24px 65px rgba(67,36,78,.12);padding:28px!important}
      .stageIntro{padding:4px 0 14px;border-bottom:3px solid #d75aa7;align-items:flex-start!important}.stageIntro b{display:block;font-size:24px;line-height:1.1;color:#5b267d}
      .stageIntro>div:last-child>div{color:#6f6378;opacity:1!important;margin-top:4px;line-height:1.45}
      .aiBadge{background:linear-gradient(135deg,#ef5e72,#8c2bb6)!important;color:#fff;flex:0 0 42px}
      .photoNote{color:#6b4b05!important;background:#fff7dc!important;border-color:#e8bf4f!important}
      .photoInput{display:block;width:100%;padding:12px;border:1px solid #ddcde1;border-radius:16px;background:#fffaf7;color:#24152e;font:inherit}
      .photoInput::file-selector-button{border:0;border-radius:999px;padding:10px 16px;margin-right:12px;background:#f0e4f5;color:#5b267d;font-weight:900;cursor:pointer}
      .vibeButtons{gap:10px!important}
      .vibeButton{color:#24152e!important;background:#f7eef8!important;border:1px solid #d8c1e2!important;min-height:44px}
      .vibeButton[aria-pressed="true"]{color:#fff!important;background:linear-gradient(135deg,#ef5e72,#8c2bb6)!important;border-color:transparent!important;box-shadow:0 8px 20px rgba(122,42,184,.2)}
      .storyChatPanel{margin-top:18px;padding:24px;border-radius:20px;background:#09070b;color:#fff;border:3px solid #24152e;box-shadow:0 14px 36px rgba(36,21,46,.25);min-height:68vh;display:flex;flex-direction:column}.chatTitle{font-size:28px;font-weight:900;letter-spacing:.5px;color:#ff7ead;margin-bottom:18px}.chatMessages{display:grid;gap:12px;min-height:34vh;max-height:52vh;overflow:auto;margin-bottom:20px;font-size:20px}.chatBubble{padding:16px 18px;border-radius:15px;line-height:1.55}.assistantBubble{background:#24182f;border:1px solid #5c4470}.userBubble{background:linear-gradient(135deg,#7a2ab8,#ef4b8c);margin-left:12%}.typeHereLabel{display:block;font-size:22px;font-weight:900;color:#fff;margin:8px 0 10px}.storyInput{width:100%!important;border:2px solid #ff7ead!important;background:#000!important;color:#fff!important;box-shadow:0 0 0 3px rgba(255,126,173,.12);line-height:1.55;resize:vertical}.chatInput{min-height:190px;padding:18px;border-radius:14px;font-size:20px}.sendChatButton{margin-top:14px;min-height:54px;width:100%;border:0;border-radius:999px;padding:14px 20px;background:#fff;color:#24152e;font-size:18px;font-weight:900;cursor:pointer}
      .storyInput::placeholder{color:#d8cfe0;font-weight:800}
      .primaryButton,.previewButton{border:0!important;color:#fff!important;background:linear-gradient(135deg,#ef5e72,#ef4b8c 45%,#8c2bb6)!important;box-shadow:0 12px 28px rgba(178,52,137,.22);cursor:pointer;font-size:16px}
      .secondaryButton,.draftButton{color:#5b267d!important;background:#f5eaf8!important;border:1px solid #d8c1e2!important;cursor:pointer}
      .draftButton[aria-pressed="true"]{color:#fff!important;background:#7a2ab8!important}
      button:disabled{opacity:.52;cursor:not-allowed!important}
      .statusLine{color:#5b267d;font-weight:800;line-height:1.45}
      .photoResult{color:#fff!important}
      .storyHeading h2{font-family:Georgia,serif;font-size:34px;line-height:1.05;margin:7px 0 12px}.editHelp{color:#66566e;line-height:1.5}.customerStory{background:#09070b!important;color:#fff!important}.storyActions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}.storyActions button{padding:14px 20px;border-radius:999px;font-weight:900}
      .storyChoice h2{font-family:Georgia,serif;font-size:32px;line-height:1.05;margin:8px 0 12px}
      .storyChoice p{font-size:17px;line-height:1.6;color:#55475d;margin:0}
      .optionLabel{font-size:12px;letter-spacing:2px;font-weight:900;color:#7a2ab8}
      .planDetails{border:1px solid #ddcde1;border-radius:18px;padding:16px;background:#fff}
      .planDetails summary{font-weight:900;color:#5b267d;cursor:pointer}
      .planDetails>p{color:#6f6378;line-height:1.5}
      .simplePreviewCopy{color:#55475d;line-height:1.55}
      .workingToast{position:fixed;z-index:9999;left:50%;bottom:24px;transform:translateX(-50%);width:min(680px,calc(100% - 28px));display:flex;align-items:center;gap:12px;padding:16px 18px;border-radius:18px;background:#24152e;color:#fff;box-shadow:0 18px 55px rgba(36,21,46,.35);font-weight:900;line-height:1.4}
      .workingSpinner{width:22px;height:22px;flex:0 0 22px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:mcsSpin .8s linear infinite}
      @keyframes mcsSpin{to{transform:rotate(360deg)}}
      .planInput{min-height:420px!important}
      @media(max-width:640px){
        .createShell{padding:16px!important}
        .createHeader{align-items:flex-start!important}
        .createTitle{font-size:30px!important;line-height:1.05!important;margin-top:18px!important}
        .createSubtitle{font-size:15px!important;line-height:1.45}
        .createCard{padding:14px!important;border-radius:18px!important}
        .storyChatPanel{padding:18px!important;min-height:72vh}.chatTitle{font-size:24px}.chatMessages{min-height:36vh;max-height:55vh;font-size:19px}.chatInput{min-height:180px;font-size:18px}
        .stageIntro{display:block!important}
        .aiBadge{margin-bottom:12px}
        .vibeButtons{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))}
        .vibeButton{width:100%}
        .primaryButton,.previewButton,.secondaryButton,.sendChatButton{display:block;width:100%;min-height:44px;padding:11px 14px!important;font-size:15px!important}
        .photoInput{padding:10px}
      }
    `}</style>
  </main>
}
