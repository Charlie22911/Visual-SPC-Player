import { useEffect,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpcAudioEngine } from '../audio/engine';
import type { VisualizerRate } from '../settings';
import type { SpectrumFrame,SpectrumSettings } from './types';
import { applySpectrumPreset } from './settings';
import { spectrumColor,spectrumFrequency } from './displayMath';
import { SpectrumRenderer,type SpectrumRenderStats } from './SpectrumRenderer';
type Props={engine:SpcAudioEngine;settings:SpectrumSettings;onSettingsChange(s:SpectrumSettings):void;refreshRate:VisualizerRate;displayHz:number|null;footerTarget?:HTMLElement|null};
export function SpectrogramPanel({engine,settings,onSettingsChange,refreshRate,displayHz,footerTarget}:Props){
 const plot=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),renderer=useRef<SpectrumRenderer|null>(null);
 const current=useRef({settings,refreshRate}),size=useRef({width:1,height:1});current.current={settings,refreshRate};
 const future=useRef<SpectrumFrame[]>([]),[error,setError]=useState('');
 const [stats,setStats]=useState<SpectrumRenderStats&{rate:number;averageMs:number}>({backend:'',draws:0,uploaded:0,projected:0,pending:0,bytes:0,rate:0,averageMs:0});
 const update=(patch:Partial<SpectrumSettings>,custom=false)=>onSettingsChange({...settings,...patch,...(custom?{preset:'custom' as const}:{})});
 useEffect(()=>{
  let raf=0,disposed=false,next=0,since=performance.now(),draws=0,total=0;
  const measure=()=>{if(!plot.current)return;const box=plot.current.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
   size.current={width:Math.max(1,Math.floor(box.width*dpr)),height:Math.max(1,Math.floor(box.height*dpr))};
   renderer.current?.configure(current.current.settings,size.current.width,size.current.height);
  };
  const create=()=>{if(disposed||document.hidden||!canvas.current)return;
   try{if(!renderer.current)renderer.current=new SpectrumRenderer(canvas.current);measure();setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  const paint=(now:number)=>{
   if(disposed||document.hidden)return;
   const rate=current.current.refreshRate,period=rate==='display'?0:1000/rate;
   if(!period||now>=next){
    const start=performance.now(),clock=engine.spectrumClock();
    try{
     for(let i=0;i<future.current.length;){const frame=future.current[i];
      if(frame.generation<clock.generation){future.current.splice(i,1);continue;}
      if(frame.generation===clock.generation&&frame.nativeFrame<=clock.nativeFrame+16000){renderer.current?.upload(frame);future.current.splice(i,1);continue;}++i;
     }
     renderer.current?.update();renderer.current?.draw(clock.nativeFrame,clock.generation);
     ++draws;total+=performance.now()-start;
     if(now-since>=1000){const s=renderer.current?.stats();if(s)setStats({...s,rate:Math.round(draws*1000/(now-since)),averageMs:total/draws});since=now;draws=0;total=0;}
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    next=period?Math.max(next+period,now+period*.5):now;
   }raf=requestAnimationFrame(paint);
  };
  const visibility=()=>{
   cancelAnimationFrame(raf);future.current=[];
   if(document.hidden){engine.setSpectrumOptions(null);renderer.current?.dispose();renderer.current=null;return;}
   create();engine.setSpectrumOptions(current.current.settings);next=0;raf=requestAnimationFrame(paint);
  };
  create();if(!document.hidden){engine.setSpectrumOptions(current.current.settings);raf=requestAnimationFrame(paint);}
  const unsubscribe=engine.on('spectrum',frame=>{
   if(disposed||document.hidden)return;
   const clock=engine.spectrumClock();
   if(frame.generation<clock.generation)return;
   if(frame.generation===clock.generation&&frame.nativeFrame<=clock.nativeFrame+16000)renderer.current?.upload(frame);
   else {if(future.current.length===64)future.current.shift();future.current.push({...frame,values:frame.values.slice()});}
  });
  const resize=new ResizeObserver(()=>{try{measure();}catch(e){setError(String(e));}});if(plot.current)resize.observe(plot.current);
  const lost=(event:Event)=>{event.preventDefault();engine.setSpectrumOptions(null);setError('The spectrum graphics context was lost. Reopen this tab to restart it.');cancelAnimationFrame(raf);};
  canvas.current?.addEventListener('webglcontextlost',lost);document.addEventListener('visibilitychange',visibility);
  return()=>{disposed=true;unsubscribe();cancelAnimationFrame(raf);resize.disconnect();document.removeEventListener('visibilitychange',visibility);canvas.current?.removeEventListener('webglcontextlost',lost);engine.setSpectrumOptions(null);renderer.current?.dispose();renderer.current=null;future.current=[];};
 },[engine]);
 useEffect(()=>{if(!document.hidden)engine.setSpectrumOptions(settings);try{renderer.current?.configure(settings,size.current.width,size.current.height);}catch(e){setError(String(e));}},[engine,settings]);
 const palette=settings.difference?'grayscale':settings.palette;
 const gradient=`linear-gradient(90deg,${Array.from({length:16},(_,i)=>{const c=spectrumColor(i*17,palette);return `rgb(${c[0]} ${c[1]} ${c[2]}) ${i/15*100}%`;}).join(',')})`;
 const footer=<div className="spectrum-footer"><div className="visual-status"><span className="live-status">{stats.rate} draws/s</span><span>Target · {refreshRate==='display'?`${displayHz??'…'} Hz display`:`${refreshRate} Hz`}</span><span>{stats.backend} · {stats.averageMs.toFixed(2)} ms submission · {stats.pending} pending rows · {(stats.bytes/1048576).toFixed(1)} MiB</span></div><div className="legend">{settings.difference?'Brightness: (Left − Right) / 2 power; identical channels black; includes phase differences':'Stereo power before playback volume · 0 dBFS = full-scale sine'} · Hann {settings.fftSize}, hop {settings.hopSize} · 32 kHz</div></div>;
 return <section className="spectrum-panel" aria-label="Spectrogram">
  <div className="panel-toolbar spectrum-toolbar">
   <select aria-label="Spectrogram preset" value={settings.preset} onChange={e=>onSettingsChange(applySpectrumPreset(e.target.value as SpectrumSettings['preset'],settings))}>{[['balanced','Balanced'],['transient','Transient detail'],['frequency','Frequency detail'],['raw','Raw analysis'],['custom','Custom']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
   <label><input type="checkbox" checked={settings.difference} onChange={e=>update({difference:e.target.checked})}/>Stereo difference</label>
   <select aria-label="Spectrogram palette" value={settings.palette} disabled={settings.difference} onChange={e=>update({palette:e.target.value as SpectrumSettings['palette']})}>{['green','heat','grayscale'].map(v=><option key={v}>{v}</option>)}</select>
   <span className="value-gradient" style={{background:gradient}} title={`${settings.floorDb} to ${settings.ceilingDb} dBFS`}/>
   <select aria-label="Spectrogram sampling" value={settings.sampling} onChange={e=>update({sampling:e.target.value as SpectrumSettings['sampling']},true)}>{['nearest','smooth','area'].map(v=><option key={v}>{v}</option>)}</select>
   <label><input type="checkbox" checked={settings.logarithmic} onChange={e=>update({logarithmic:e.target.checked})}/>Log frequency</label>
   <select aria-label="FFT size" value={settings.fftSize} onChange={e=>update({fftSize:Number(e.target.value) as SpectrumSettings['fftSize']},true)}>{[1024,2048,4096].map(v=><option key={v} value={v}>FFT {v}</option>)}</select>
   <select aria-label="Analysis hop" value={settings.hopSize} onChange={e=>update({hopSize:Number(e.target.value) as SpectrumSettings['hopSize']},true)}>{[64,128,256,512].map(v=><option key={v} value={v}>Hop {v}</option>)}</select>
   <label><input type="checkbox" checked={settings.temporal} onChange={e=>update({temporal:e.target.checked,...(e.target.checked&&settings.temporalMs===0?{temporalMs:25}:{})},true)}/>Temporal smoothing</label>
   {settings.temporal&&<label>{settings.temporalMs} ms<input aria-label="Spectrogram smoothing duration" type="range" min="1" max="200" value={settings.temporalMs} onChange={e=>update({temporalMs:Number(e.target.value)},true)}/></label>}
   <select aria-label="Spectrogram time span" value={settings.seconds} onChange={e=>update({seconds:Number(e.target.value) as SpectrumSettings['seconds']})}>{[2,5,10].map(v=><option key={v} value={v}>{v} s</option>)}</select>
   <label>Floor {settings.floorDb} dBFS<input aria-label="Spectrogram floor" type="range" min="-120" max="-30" value={settings.floorDb} onChange={e=>update({floorDb:Number(e.target.value)})}/></label>
   <label>Top {settings.ceilingDb} dBFS<input aria-label="Spectrogram top" type="range" min="-30" max="0" value={settings.ceilingDb} onChange={e=>update({ceilingDb:Number(e.target.value)})}/></label>
  </div>
  <div className="spectrum-stage">
   <div className="spectrum-frequency-axis">{[0,.25,.5,.75,1].map(v=><span key={v}>{Math.round(spectrumFrequency(v,settings.logarithmic)).toLocaleString()} Hz</span>)}</div>
   <div className="spectrum-time-axis">{[0,.25,.5,.75,1].map(v=><span key={v}>−{(settings.seconds*v).toFixed(1)}s</span>)}</div>
   <div className="spectrum-plot" ref={plot}><canvas ref={canvas} aria-label="Audio power spectrogram" style={{width:'100%',height:'100%',display:'block'}}/></div>
   {error&&<p className="spectrum-error" role="alert">{error}</p>}
  </div>
  {footerTarget?createPortal(footer,footerTarget):footer}
 </section>;
}
