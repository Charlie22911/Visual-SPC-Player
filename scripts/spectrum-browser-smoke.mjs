import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions,artifactPath} from './browser-environment.mjs';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4187','--strictPort'],{stdio:'pipe'});
let browser;
try{
 for(let i=0;i<100;++i){try{if((await fetch('http://127.0.0.1:4187')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch(browserLaunchOptions);const page=await browser.newPage();await page.goto('http://127.0.0.1:4187');
 const report=await page.evaluate(async()=>{
  const {SpectrumRenderer}=await import('/src/spectrum/SpectrumRenderer.ts');
  const {defaultSpectrumSettings}=await import('/src/spectrum/settings.ts');
  const gpuCanvas=document.createElement('canvas'),cpuCanvas=document.createElement('canvas');
  const gpu=new SpectrumRenderer(gpuCanvas),cpu=new SpectrumRenderer(cpuCanvas,true);
  if(gpu.stats().backend!=='WebGL 2')throw new Error('WebGL2 with floating-point buffers is required for this GPU check');
  const gl=gpuCanvas.getContext('webgl2'),info=gl.getExtension('WEBGL_debug_renderer_info');
  const adapter=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  const width=53,height=41,hop=256,frames=[];
  for(let i=0;i<80;++i){const values=new Float32Array(1026);for(let bin=0;bin<513;++bin){values[bin*2]=Math.pow(10,-(bin%70)/10)*(.2+i/100);values[bin*2+1]=bin%4?values[bin*2]*.25:0;}
   values[0]=1;values[2]=1e-12;values[4]=1e-11;
   frames.push({epoch:1,generation:1,sequence:i+1,segment:1,nativeFrame:9e9+1024+i*hop,bins:513,values});
  }
  const finish=async r=>{for(let i=0;i<1000&&r.stats().pending;++i){r.update(2);await new Promise(resolve=>requestAnimationFrame(resolve));}if(r.stats().pending)throw new Error('Projection backlog did not drain');};
  let cases=0;
  for(const sampling of ['nearest','smooth','area'])for(const logarithmic of [false,true])for(const temporal of [false,true])for(const difference of [false,true]){
   const settings={...defaultSpectrumSettings,fftSize:1024,hopSize:hop,seconds:2,sampling,logarithmic,temporal,temporalMs:200,difference};
   gpu.configure(settings,width,height);cpu.configure(settings,width,height);
   if(!cases)for(const f of frames){gpu.upload(f);cpu.upload(f);}
   await finish(gpu);await finish(cpu);
   for(const slot of [0,1,20,79]){const actual=gpu.readProjected(slot),expected=cpu.readProjected(slot);for(let x=0;x<width;++x){const tolerance=Math.max(1e-18,Math.abs(expected[x])*2e-5);if(Math.abs(actual[x]-expected[x])>tolerance)throw new Error(`Numeric parity ${sampling} ${logarithmic} ${temporal} ${difference} slot${slot} x${x}: ${actual[x]} vs ${expected[x]}`);}}
   const audible=frames.at(-1).nativeFrame+63;gpu.draw(audible,1);cpu.draw(audible,1);
   const actual=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,actual);
   const expected=cpuCanvas.getContext('2d').getImageData(0,0,width,height).data;
   for(let y=0;y<height;++y)for(let x=0;x<width;++x)for(let c=0;c<3;++c){const a=actual[((height-1-y)*width+x)*4+c],b=expected[(y*width+x)*4+c];if(Math.abs(a-b)>2)throw new Error(`Image parity ${sampling} x${x} y${y}: ${a} vs ${b}`);}
   ++cases;
  }
  const before=gpu.stats();for(let i=0;i<120;++i)gpu.draw(frames.at(-1).nativeFrame+i*2,1);const after=gpu.stats();
  if(after.projected!==before.projected||after.uploaded!==before.uploaded)throw new Error('Drawing reprocessed retained spectrum rows');
  gpu.dispose();cpu.dispose();return{adapter,cases,drawsWithoutNewAnalysis:120};
 });
 await writeFile(artifactPath('spectrum-gpu-browser.json'),JSON.stringify(report,null,2));console.log(report);
}finally{await browser?.close();server.kill();}
