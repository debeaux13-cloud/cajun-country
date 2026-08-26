import {useEffect,useState} from 'react';
import {useRouter} from 'next/router';

export default function Preview(){
  const router=useRouter();
  const {jobId,mcsJobId}=router.query;
  const [job,setJob]=useState(null);
  const [message,setMessage]=useState('Starting your moving preview…');
  const [paying,setPaying]=useState(false);

  useEffect(()=>{
    if(!jobId)return;
    let stopped=false;
    let timer;
    async function check(){
      try{
        const r=await fetch('/api/job?jobId='+encodeURIComponent(jobId),{cache:'no-store'});
        const j=await r.json();
        if(stopped)return;
        setJob(j);
        const s=String(j.status||'').toUpperCase();
        if(s==='COMPLETED')setMessage('Your 60-second preview is ready.');
        else if(s==='FAILED')setMessage(j.error||'Preview generation failed. Please retry.');
        else if(s==='IN_PROGRESS')setMessage('Your characters are moving — rendering preview…');
        else setMessage('Your preview is queued and starting…');
        if(!['COMPLETED','FAILED','CANCELLED'].includes(s))timer=setTimeout(check,3000);
      }catch(e){
        if(!stopped){setMessage('Still checking your preview…');timer=setTimeout(check,4000);}
      }
    }
    check();
    return()=>{stopped=true;clearTimeout(timer)};
  },[jobId]);

  async function checkout(){
    setPaying(true);
    try{
      const r=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,mcsJobId})});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||'Checkout failed');
      location.href=j.url;
    }catch(e){setMessage(e.message);setPaying(false)}
  }

  const completed=String(job?.status||'').toUpperCase()==='COMPLETED';
  const videoUrl=completed&&mcsJobId?'/api/preview-media?id='+encodeURIComponent(mcsJobId):job?.videoUrl||null;
  const done=completed&&videoUrl;
  const progress=job?.progress;
  return <main style={{minHeight:'100vh',background:'#0d0912',color:'#fff',fontFamily:'Arial,sans-serif'}}>
    <div style={{maxWidth:920,margin:'0 auto',padding:24}}>
      <a href='/create' style={{color:'#fff'}}>← Back to story</a>
      <h1 style={{fontFamily:'Georgia,serif',fontSize:'clamp(40px,7vw,72px)',marginBottom:10}}>Your story is coming alive.</h1>
      <p style={{fontSize:18,opacity:.85}}>{message}</p>
      {typeof progress==='number'&&<div style={{height:12,background:'#2a2130',borderRadius:99,overflow:'hidden',margin:'22px 0'}}><div style={{height:'100%',width:Math.max(4,Math.min(100,progress))+'%',background:'#8a3ffc'}}/></div>}
      {done?<>
        <video src={videoUrl} controls autoPlay playsInline style={{width:'100%',maxHeight:'70vh',borderRadius:24,background:'#000'}}/>
        <div style={{background:'#19121f',border:'1px solid #3d2d49',borderRadius:22,padding:22,marginTop:22}}>
          <h2>Love the opening minute? Finish the movie.</h2>
          <div style={{fontSize:42,fontWeight:900}}>$79</div>
          <p>Continue this same story into your 5-minute personalized moving movie.</p>
          <button onClick={checkout} disabled={paying} style={{padding:'15px 22px',border:0,borderRadius:999,fontWeight:900,fontSize:17,cursor:'pointer'}}>{paying?'Opening secure checkout…':'Continue my movie →'}</button>
        </div>
      </>:<div style={{padding:'42px 0',opacity:.75}}>You can leave this tab open while the preview renders. This page checks the job automatically.</div>}
    </div>
  </main>
}
