import {useEffect,useState} from 'react';
import {useRouter} from 'next/router';

const ORDER_KEY='mcs-latest-checkout-session';
const ORDER_REF_KEY='mcs-latest-order-reference';

function label(state){
  if(state==='ready')return 'Ready to watch';
  if(state==='needs_attention')return 'Studio review';
  if(state==='rendering')return 'Rendering';
  if(state==='starting')return 'Starting';
  return 'In queue';
}

export default function MyOrders(){
  const router=useRouter();
  const[sessionId,setSessionId]=useState('');
  const[orderId,setOrderId]=useState('');
  const[order,setOrder]=useState(null);
  const[error,setError]=useState('');
  const[lastChecked,setLastChecked]=useState('');

  useEffect(()=>{
    if(!router.isReady)return;
    const queryId=Array.isArray(router.query.session_id)?router.query.session_id[0]:router.query.session_id;
    const queryOrder=Array.isArray(router.query.order_id)?router.query.order_id[0]:router.query.order_id;
    const id=String(queryId||window.localStorage.getItem(ORDER_KEY)||'').trim();
    const orderRef=String(queryOrder||window.localStorage.getItem(ORDER_REF_KEY)||'').trim();
    if(id){
      setSessionId(id);
      setOrderId(orderRef);
      if(queryId||queryOrder){
        window.localStorage.setItem(ORDER_KEY,id);
        if(orderRef)window.localStorage.setItem(ORDER_REF_KEY,orderRef);
        router.replace('/my-orders',undefined,{shallow:true});
      }
    }
  },[router.isReady,router.query.session_id,router.query.order_id]);

  useEffect(()=>{
    if(!sessionId)return;
    let active=true;
    let timer;
    const check=async()=>{
      try{
        const response=await fetch('/api/order-status',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sessionId,orderId})
        });
        const result=await response.json();
        if(!response.ok&&response.status!==202)throw new Error(result.error||'Order status is unavailable');
        if(!active)return;
        setOrder(result);setError('');setLastChecked(new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'}));
        if(!['ready','needs_attention'].includes(result.state))timer=setTimeout(check,12000);
      }catch(e){
        if(!active)return;
        setError(e.message);timer=setTimeout(check,20000);
      }
    };
    check();
    return()=>{active=false;if(timer)clearTimeout(timer)};
  },[sessionId,orderId]);

  return <main style={{minHeight:'100vh',background:'#fff7f1',color:'#24152e',fontFamily:'Arial,sans-serif'}}>
    <div style={{maxWidth:900,margin:'0 auto',padding:24}}>
      <a href='/' style={{color:'#24152e'}}>← Main Character Studios by Tiffani</a>
      <h1 style={{fontFamily:'Georgia,serif',fontSize:'clamp(42px,7vw,70px)',marginBottom:8}}>My Orders</h1>
      {!sessionId&&<section style={{marginTop:24,background:'#fff',border:'1px solid #e6d8e8',borderRadius:22,padding:24}}><h2>Your movies live here.</h2><p>Open the confirmation link from your checkout on this device to see the latest order.</p></section>}
      {sessionId&&<section style={{marginTop:24,background:'#fff',border:'1px solid #e6d8e8',borderRadius:22,padding:24}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}>
          <div><small style={{letterSpacing:1.5,fontWeight:900,color:'#7b2cff'}}>3-MINUTE PERSONALIZED MOVIE</small><h2 style={{margin:'8px 0'}}>{order?.state==='ready'?'Your movie is ready':order?.state==='rendering'?'Your movie is being made':'Payment received'}</h2></div>
          <strong style={{padding:'10px 14px',borderRadius:999,background:'#f0e5ff',color:'#5f20b5'}}>{label(order?.state)}</strong>
        </div>
        <p style={{fontSize:18,lineHeight:1.6}}>{order?.message||'Your movie is continuing from the preview you approved.'}</p>
        {order&&!['ready','needs_attention'].includes(order.state)&&<div style={{margin:'20px 0',padding:18,borderRadius:18,background:'#fbf4ff',border:'1px solid #e3d1f5'}}>
          <strong style={{display:'block',fontSize:18,marginBottom:10}}>{order.state==='rendering'?'Production is active':'Preparing production'}</strong>
          <progress aria-label='Movie production is active' style={{width:'100%',height:18,accentColor:'#7b2cff'}}/>
          <p style={{margin:'10px 0 4px',lineHeight:1.5}}>Scenes 7–18 are being created, narrated, and assembled automatically.</p>
          <small style={{color:'#6d6073'}}>This page checks automatically{lastChecked?` · Last checked ${lastChecked}`:''}.</small>
        </div>}
        {order?.progress!=null&&<p><b>Latest update:</b> {String(order.progress)}</p>}
        {order?.completedScenes&&<p><b>Scenes complete:</b> {order.completedScenes} of 18</p>}
        {error&&<p style={{color:'#8a2d2d'}}>We could not refresh right now. Your order is safe and this page will try again.</p>}
        {order?.state==='ready'&&<div style={{marginTop:22}}>
          <video src={order.movieUrl} controls playsInline style={{width:'100%',borderRadius:20,background:'#000'}}/>
          <p><a href={order.storybookUrl} target='_blank' rel='noreferrer' style={{fontWeight:900,color:'#6d24c7'}}>Open the matching storybook PDF →</a></p>
        </div>}
        {order?.state==='needs_attention'&&<p style={{padding:14,borderRadius:14,background:'#fff2d6'}}>No additional payment is needed. Main Character Studios has the order and will review the render before delivery.</p>}
      </section>}
    </div>
  </main>;
}
