import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/router';

const terminalStatuses=['COMPLETED','FAILED','CANCELLED'];

function clock(total){
  const seconds=Math.max(0,Math.floor(total));
  return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
}

export default function Preview(){
  const router=useRouter();
  const {jobId,mcsJobId}=router.query;
  const [job,setJob]=useState(null);
  const [message,setMessage]=useState('Starting your moving preview…');
  const [paying,setPaying]=useState(false);
  const [elapsed,setElapsed]=useState(0);
  const [checkedAt,setCheckedAt]=useState(null);
  const [production,setProduction]=useState(null);

  useEffect(()=>{
    if(!jobId)return;
    const storageKey='mcs-preview-start-'+jobId;
    let started=Date.now();
    try{
      const saved=Number(sessionStorage.getItem(storageKey));
      if(saved>0)started=saved;else sessionStorage.setItem(storageKey,String(started));
    }catch{}
    const tick=()=>setElapsed((Date.now()-started)/1000);
    tick();
    const interval=setInterval(tick,1000);
    return()=>clearInterval(interval);
  },[jobId]);

  useEffect(()=>{
    if(!jobId)return;
    let stopped=false;
    let timer;
    async function check(){
      try{
        const r=await fetch('/api/job?jobId='+encodeURIComponent(jobId),{cache:'no-store'});
        const j=await r.json();
        if(stopped)return;
        if(!r.ok)throw new Error(j.error||'Status check failed');
        setJob(j);
        setCheckedAt(new Date());
        const s=String(j.status||'').toUpperCase();
        if(s==='COMPLETED')setMessage('Your 60-second preview is ready.');
        else if(s==='FAILED'||s==='CANCELLED')setMessage(j.error||'We could not finish this preview. Please return to your story and try again.');
        else if(s==='IN_PROGRESS')setMessage('Your characters are moving — your preview is rendering.');
        else setMessage('Your preview is in line and will begin automatically.');
        if(!terminalStatuses.includes(s))timer=setTimeout(check,3000);
      }catch{
        if(!stopped){
          setMessage('Your movie is still processing. Reconnecting for the latest update…');
          timer=setTimeout(check,4000);
        }
      }
    }
    check();
    return()=>{stopped=true;clearTimeout(timer)};
  },[jobId]);

  useEffect(()=>{
    if(!mcsJobId)return;
    let stopped=false;
    let timer;
    async function checkProduction(){
      try{
        const response=await fetch('/api/preview-progress?mcsJobId='+encodeURIComponent(mcsJobId),{cache:'no-store'});
        const next=await response.json();
        if(!stopped&&response.ok){
          setProduction(next);
          if(next.message&&String(job?.status||'').toUpperCase()!=='COMPLETED')setMessage(next.message);
        }
      }catch{}
      if(!stopped)timer=setTimeout(checkProduction,3000);
    }
    checkProduction();
    return()=>{stopped=true;clearTimeout(timer)};
  },[mcsJobId,job?.status]);

  async function checkout(){
    setPaying(true);
    try{
      const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,mcsJobId})});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'Checkout failed');
      location.href=j.url;
    }catch(e){setMessage(e.message);setPaying(false)}
  }

  const status=String(job?.status||'').toUpperCase();
  const completed=status==='COMPLETED';
  const failed=status==='FAILED'||status==='CANCELLED';
  const working=!completed&&!failed;
  const videoUrl=completed&&mcsJobId?'/api/preview-media?id='+encodeURIComponent(mcsJobId):job?.videoUrl||null;
  const done=completed&&videoUrl;
  const numericProgress=typeof production?.progress==='number'?Math.max(0,Math.min(100,production.progress)):typeof job?.progress==='number'?Math.max(0,Math.min(100,job.progress)):null;
  const productionLabel=useMemo(()=>{
    if(status==='IN_QUEUE')return 'Waiting for the movie studio';
    if(production?.completedScenes>0)return production.completedScenes+' of 6 scenes finished';
    if(production?.activeScenes>0)return 'Building '+production.activeScenes+' movie scenes';
    if(status==='IN_PROGRESS')return elapsed<45?'Preparing the cast and scenes':'Rendering your moving story';
    return 'Connecting to the movie studio';
  },[status,elapsed,production]);

  return <main className='page'>
    <div className='shell'>
      <a href='/create' className='back'>← Back to story</a>
      <section className='hero'>
        <div className='eyebrow'>{done?'PREVIEW READY':failed?'NEEDS ATTENTION':'MOVIE IN PRODUCTION'}</div>
        <h1>{done?'Press play.':'Your story is coming alive.'}</h1>
        <p className='message'>{message}</p>

        {working&&<div className='productionCard' aria-live='polite'>
          <div className='spinner' aria-hidden='true'/>
          <div className='productionCopy'>
            <strong>{productionLabel}</strong>
            <span>{numericProgress!==null?Math.round(numericProgress)+'% complete':'Working now · '+clock(Math.max(elapsed,Number(job?.executionTime||0)/1000+Number(job?.delayTime||0)/1000))+' elapsed'}</span>
          </div>
          <div className={'progressTrack '+(numericProgress===null?'indeterminate':'')}>
            <div className='progressFill' style={numericProgress===null?undefined:{width:Math.max(4,numericProgress)+'%'}}/>
          </div>
          <div className='statusRow'>
            <span><i className='liveDot'/> Page is checking automatically</span>
            <span>{checkedAt?'Updated '+checkedAt.toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'Connecting…'}</span>
          </div>
        </div>}

        {failed&&<div className='errorCard'>
          <strong>This preview stopped before it finished.</strong>
          <p>{job?.error||'Your story is saved. We recorded the worker error for review.'}</p>
          <a href='/create' className='actionLink'>Return to my story</a>
        </div>}

        {done&&<video src={videoUrl} controls autoPlay playsInline className='video'/>}

        {done&&<div className='finishCard'>
          <div>
            <div className='eyebrow'>FULL 3-MINUTE MOVIE</div>
            <h2>Love the opening minute? Finish their movie.</h2>
            <p>Keep this exact story going for the remaining two minutes.</p>
          </div>
          <div className='price'>$49</div>
          <button onClick={checkout} disabled={paying}>{paying?'Opening secure checkout…':'Finish my movie →'}</button>
        </div>}

        {working&&<p className='leaveNote'>You may leave this tab open or come back later. Your movie keeps working, and this page will switch to the video automatically when it is ready.</p>}
      </section>
    </div>
    <style jsx>{`
      *{box-sizing:border-box}
      .page{min-height:100vh;background:linear-gradient(145deg,#fff8f3 0%,#f8e9fa 52%,#f2eaff 100%);color:#21132b;font-family:Arial,sans-serif;padding:18px 14px 60px}
      .shell{max-width:900px;margin:0 auto}
      .back{display:inline-block;color:#6820a0;font-weight:800;text-decoration:none;margin:8px 4px 18px}
      .hero{background:rgba(255,255,255,.92);border:1px solid #eadced;border-radius:28px;padding:clamp(24px,5vw,56px);box-shadow:0 24px 70px rgba(61,22,78,.12);overflow:hidden}
      .eyebrow{color:#862bc1;font-weight:900;letter-spacing:.16em;font-size:13px}
      h1{font-family:Georgia,serif;font-size:clamp(42px,8vw,76px);line-height:.96;margin:14px 0 18px;max-width:760px}
      .message{font-size:clamp(18px,3vw,23px);line-height:1.45;margin:0 0 26px;color:#5a4c60}
      .productionCard{position:relative;border:1px solid #e4d0eb;border-radius:24px;padding:24px;background:linear-gradient(135deg,#fff7fb,#f4e8ff);display:grid;grid-template-columns:54px 1fr;gap:8px 18px;box-shadow:0 10px 30px rgba(91,40,117,.08)}
      .spinner{width:48px;height:48px;border-radius:50%;border:5px solid #eadcf0;border-top-color:#d83b9d;border-right-color:#8134d6;animation:spin .85s linear infinite;grid-row:1}
      .productionCopy{display:flex;flex-direction:column;justify-content:center;gap:5px}
      .productionCopy strong{font-size:20px}
      .productionCopy span{color:#74657a;font-weight:700}
      .progressTrack{height:13px;background:#e7ddea;border-radius:99px;overflow:hidden;grid-column:1/-1;margin-top:15px}
      .progressFill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#ff557b,#d935a8,#7335dc);transition:width .6s ease}
      .indeterminate .progressFill{width:42%;animation:travel 1.4s ease-in-out infinite}
      .statusRow{grid-column:1/-1;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#716576;font-size:13px;margin-top:6px}
      .liveDot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#26a760;margin-right:7px;box-shadow:0 0 0 5px rgba(38,167,96,.12);animation:pulse 1.5s infinite}
      .leaveNote{font-size:16px;line-height:1.55;color:#6d5d72;margin:24px 4px 0;max-width:700px}
      .video{display:block;width:100%;max-height:70vh;border-radius:22px;background:#000;box-shadow:0 18px 48px rgba(24,9,31,.24)}
      .finishCard,.errorCard{margin-top:24px;padding:24px;border-radius:22px;background:#fff;border:1px solid #e5d7e9}
      .finishCard h2{font-family:Georgia,serif;font-size:32px;margin:8px 0}
      .finishCard p,.errorCard p{color:#685b6d;line-height:1.5}
      .price{font-size:44px;font-weight:900;margin:10px 0}
      button,.actionLink{display:inline-block;border:0;border-radius:999px;padding:16px 24px;background:linear-gradient(90deg,#fb5578,#ae30bf);color:white;font-size:17px;font-weight:900;text-decoration:none;cursor:pointer}
      button:disabled{opacity:.6}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes travel{0%{transform:translateX(-110%)}50%{transform:translateX(120%)}100%{transform:translateX(-110%)}}
      @keyframes pulse{50%{opacity:.35}}
      @media(max-width:560px){
        .page{padding:10px 8px 40px}
        .hero{border-radius:22px;padding:24px 18px}
        .productionCard{padding:19px;grid-template-columns:44px 1fr}
        .spinner{width:40px;height:40px;border-width:4px}
        .productionCopy strong{font-size:17px}
        .productionCopy span{font-size:14px}
        .statusRow{flex-direction:column}
      }
    `}</style>
  </main>
}
