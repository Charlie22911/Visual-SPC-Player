import type { SpectrumFrame,SpectrumSettings } from './types';
import { spectrumColor,spectrumColumns,spectrumTaps,spectrumTimeRow,type SpectrumMeta } from './displayMath';
type Row=SpectrumMeta&{serial:number;revision:number};
export type SpectrumRenderStats={backend:string;draws:number;uploaded:number;projected:number;pending:number;bytes:number};
const vertex=`#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*vec2(2,-2)+vec2(-1,1),0,1);}`;
const project=`#version 300 es
precision highp float;precision highp int;precision highp sampler2DArray;
uniform sampler2DArray rawData;uniform sampler2D columns;
uniform int pageHeight,tapCount,difference,smoothMode;uniform int slots[9];uniform float weights[9];
out vec4 outputPower;
float powerAt(int bin,int slot){vec2 p=texelFetch(rawData,ivec3(bin,slot%pageHeight,slot/pageHeight),0).rg;return difference==1?p.g:p.r;}
void main(){vec4 col=texelFetch(columns,ivec2(int(gl_FragCoord.x),0),0);int low=int(col.r),high=int(col.g);float sum=0.;
 for(int tap=0;tap<9;++tap){if(tap>=tapCount)break;float p=0.;
 if(smoothMode==1&&high-low==2)p=powerAt(low,slots[tap])*col.a+powerAt(low+1,slots[tap])*col.b;
 else {for(int bin=low;bin<high;++bin)p+=powerAt(bin,slots[tap]);p/=float(max(1,high-low));}sum+=p*weights[tap];}
 outputPower=vec4(sum,0,0,1);}`;
const display=`#version 300 es
precision highp float;precision highp int;precision highp sampler2DArray;
uniform sampler2DArray projectedData;uniform sampler2D timeRows,palette;uniform int pageHeight,capacity;
uniform float floorDb,ceilingDb;out vec4 outputColor;
float valueAt(int x,int slot){return texelFetch(projectedData,ivec3(x,slot%pageHeight,slot/pageHeight),0).r;}
void main(){ivec2 pos=ivec2(gl_FragCoord.xy);int h=textureSize(timeRows,0).y;int y=h-1-pos.y;
 vec4 row=texelFetch(timeRows,ivec2(0,y),0);int count=int(row.g);if(count==0){outputColor=vec4(2./255.,5./255.,12./255.,1);return;}
 float p=0.;for(int i=0;i<count;++i)p+=valueAt(pos.x,(int(row.r)+i)%capacity);p/=float(count);
 if(row.a>0.)p=p*texelFetch(timeRows,ivec2(1,y),0).r+valueAt(pos.x,int(row.b))*row.a;
 float db=3.01029995664*log2(max(1e-12,p));int level=int(clamp((db-floorDb)/max(1.,ceilingDb-floorDb),0.,1.)*255.);
 outputColor=texelFetch(palette,ivec2(level,0),0);}`;

/** The live path retains metadata on the CPU and linear powers on the GPU. */
export class SpectrumRenderer {
 private gl:WebGL2RenderingContext|null=null;
 private context:CanvasRenderingContext2D|null=null;
 private programs:WebGLProgram[]=[];
 private uniforms=new WeakMap<WebGLProgram,Map<string,WebGLUniformLocation|null>>();
 private textures:WebGLTexture[]=[];
 private framebuffer:WebGLFramebuffer|null=null;
 private fence:WebGLSync|null=null;
 private settings!:SpectrumSettings;
 private width=0;private height=0;private pageHeight=0;private capacity=0;private bins=0;
 private rows:Row[]=[];private slots:(Row|undefined)[]=[];private pending:number[]=[];
 private serial=0;private revision=0;private epoch=-1;private generation=-1;
 private columns:ReturnType<typeof spectrumColumns>=[];
 private timeData=new Float32Array(0);
 private timePlan={slot:0,count:0,next:0,phase:0,lowWeight:1,first:0,last:0};
 private tapSlots=new Int32Array(9);private tapWeights=new Float32Array(9);
 private cpuRaw=new Map<number,Float32Array>();private cpuProjected=new Map<number,Float32Array>();
 private image:ImageData|null=null;
 private paletteData=new Uint8Array(1024);
 private counters={draws:0,uploaded:0,projected:0,bytes:0};
 constructor(private canvas:HTMLCanvasElement,forceCpu=false) {
  if(!forceCpu){
   const probe=document.createElement('canvas'),test=probe.getContext('webgl2');
   let supported=false;
   if(test?.getExtension('EXT_color_buffer_float')){
    // Probe programs on a disposable context before claiming the visible canvas.
    // A failed WebGL initialization must leave that canvas available to 2D.
    this.gl=test;
    try{const a=this.program(project),b=this.program(display);test.deleteProgram(a);test.deleteProgram(b);supported=true;}catch{supported=false;}finally{this.gl=null;}
   }
   test?.getExtension('WEBGL_lose_context')?.loseContext();
   if(supported)this.gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
  }
  if(this.gl){const g=this.gl;g.getExtension('EXT_color_buffer_float');this.programs=[this.program(project),this.program(display)];this.framebuffer=g.createFramebuffer();g.disable(g.BLEND);g.disable(g.DEPTH_TEST);g.disable(g.DITHER);}
  else {this.context=canvas.getContext('2d',{alpha:false});if(!this.context)throw new Error('No compatible spectrum canvas is available.');}
 }
 private program(fragment:string){
  const g=this.gl!;const p=g.createProgram()!;
  for(const [kind,source] of [[g.VERTEX_SHADER,vertex],[g.FRAGMENT_SHADER,fragment]] as const){const shader=g.createShader(kind)!;g.shaderSource(shader,source);g.compileShader(shader);if(!g.getShaderParameter(shader,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(shader)||'Spectrum shader compilation failed');g.attachShader(p,shader);g.deleteShader(shader);}
  g.linkProgram(p);if(!g.getProgramParameter(p,g.LINK_STATUS))throw new Error(g.getProgramInfoLog(p)||'Spectrum program linking failed');return p;
 }
 private uniform(program:WebGLProgram,name:string){let cache=this.uniforms.get(program);if(!cache){cache=new Map();this.uniforms.set(program,cache);}if(!cache.has(name))cache.set(name,this.gl!.getUniformLocation(program,name));return cache.get(name)!;}
 private texture(index:number,target:number,format:number,width:number,height:number,layers=1){
  const g=this.gl!;if(this.textures[index])g.deleteTexture(this.textures[index]);const t=g.createTexture()!;this.textures[index]=t;g.bindTexture(target,t);
  for(const param of [g.TEXTURE_MIN_FILTER,g.TEXTURE_MAG_FILTER])g.texParameteri(target,param,g.NEAREST);
  g.texParameteri(target,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);g.texParameteri(target,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
  if(target===g.TEXTURE_2D_ARRAY)g.texStorage3D(target,1,format,width,height,layers);else g.texStorage2D(target,1,format,width,height);
  if(g.getError()!==g.NO_ERROR)throw new Error('Spectrum graphics storage could not be allocated.');return t;
 }
 private resetRows(){this.rows=[];this.slots=Array(this.capacity);this.pending=[];this.serial=0;this.cpuRaw.clear();this.cpuProjected.clear();}
 configure(settings:SpectrumSettings,width:number,height:number){
  width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
  const old=this.settings,g=this.gl;
  const analysis=!old||old.fftSize!==settings.fftSize||old.hopSize!==settings.hopSize;
  const projection=analysis||width!==this.width||old.sampling!==settings.sampling||old.logarithmic!==settings.logarithmic||old.temporal!==settings.temporal||old.temporalMs!==settings.temporalMs||old.difference!==settings.difference;
  const output=width!==this.width||height!==this.height;
  const colors=!old||old.palette!==settings.palette||old.difference!==settings.difference;
  const page=g?Math.min(2048,g.getParameter(g.MAX_TEXTURE_SIZE)):2048;
  const layers=Math.ceil((Math.ceil(10.7*32000/settings.hopSize)+16)/page),cap=page*layers,bins=settings.fftSize/2+1;
  const bytes=cap*bins*8+cap*width*4+width*height*4+8*1024*1024;
  if(bytes>384*1024*1024)throw new Error('This spectrum configuration exceeds the 384 MiB graphics limit.');
  if(g&&(width>g.getParameter(g.MAX_TEXTURE_SIZE)||height>g.getParameter(g.MAX_TEXTURE_SIZE)||bins>g.getParameter(g.MAX_TEXTURE_SIZE)))throw new Error('The spectrum dimensions exceed this GPU’s texture limit.');
  this.settings={...settings};this.width=width;this.height=height;this.pageHeight=page;this.capacity=cap;this.bins=bins;this.counters.bytes=bytes;
  if(analysis){this.resetRows();if(g)this.texture(0,g.TEXTURE_2D_ARRAY,g.RG32F,bins,page,layers);}
  if(projection){
   ++this.revision;this.columns=spectrumColumns(settings,width);this.pending=this.rows.map(r=>r.serial);this.cpuProjected.clear();
   if(g){this.texture(1,g.TEXTURE_2D_ARRAY,g.R32F,width,page,layers);this.texture(2,g.TEXTURE_2D,g.RGBA32F,width,1);
    const data=new Float32Array(width*4);this.columns.forEach((c,x)=>data.set([c.low,c.high,c.highWeight,c.lowWeight],x*4));g.texSubImage2D(g.TEXTURE_2D,0,0,0,width,1,g.RGBA,g.FLOAT,data);
    g.bindFramebuffer(g.FRAMEBUFFER,this.framebuffer);g.framebufferTextureLayer(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,this.textures[1],0,0);
    if(g.checkFramebufferStatus(g.FRAMEBUFFER)!==g.FRAMEBUFFER_COMPLETE)throw new Error('Floating-point spectrum rendering is unavailable.');g.bindFramebuffer(g.FRAMEBUFFER,null);
   }
  }
  if(output){this.canvas.width=width;this.canvas.height=height;this.timeData=new Float32Array(height*8);if(g)this.texture(3,g.TEXTURE_2D,g.RGBA32F,2,height);else this.image=this.context!.createImageData(width,height);}
  if(colors){for(let i=0;i<256;++i)this.paletteData.set(spectrumColor(i,settings.difference?'grayscale':settings.palette),i*4);
   if(g){this.texture(4,g.TEXTURE_2D,g.RGBA8,256,1);g.texSubImage2D(g.TEXTURE_2D,0,0,0,256,1,g.RGBA,g.UNSIGNED_BYTE,this.paletteData);}}
 }
 upload(frame:SpectrumFrame){
  if(frame.bins!==this.bins)return;
  if(frame.epoch!==this.epoch||frame.generation!==this.generation){this.resetRows();this.epoch=frame.epoch;this.generation=frame.generation;}
  if(this.rows.length&&frame.nativeFrame<=this.rows[this.rows.length-1].nativeFrame)return;
  const serial=++this.serial,slot=(serial-1)%this.capacity;
  const row:Row={nativeFrame:frame.nativeFrame,sequence:frame.sequence,segment:frame.segment,slot,serial,revision:0};
  this.slots[slot]=row;if(this.rows.length===this.capacity)this.rows.shift();this.rows.push(row);this.pending.push(serial);
  if(this.pending.length>this.capacity*2)this.pending.splice(0,this.pending.length-this.capacity*2);
  const g=this.gl;
  if(g){g.bindTexture(g.TEXTURE_2D_ARRAY,this.textures[0]);g.texSubImage3D(g.TEXTURE_2D_ARRAY,0,0,slot%this.pageHeight,Math.floor(slot/this.pageHeight),this.bins,1,1,g.RG,g.FLOAT,frame.values);}
  else this.cpuRaw.set(slot,frame.values.slice());
  ++this.counters.uploaded;
 }
 private bind(unit:number,target:number,texture:WebGLTexture){const g=this.gl!;g.activeTexture(g.TEXTURE0+unit);g.bindTexture(target,texture);}
 update(budgetMs=.75){
  const g=this.gl;if(!this.pending.length)return;
  if(g&&this.fence){const status=g.clientWaitSync(this.fence,0,0);if(status===g.TIMEOUT_EXPIRED)return;g.deleteSync(this.fence);this.fence=null;}
  const start=performance.now();let count=0;
  if(g){const p=this.programs[0];g.useProgram(p);this.bind(0,g.TEXTURE_2D_ARRAY,this.textures[0]);this.bind(1,g.TEXTURE_2D,this.textures[2]);g.uniform1i(this.uniform(p,'rawData'),0);g.uniform1i(this.uniform(p,'columns'),1);g.uniform1i(this.uniform(p,'pageHeight'),this.pageHeight);g.uniform1i(this.uniform(p,'difference'),+this.settings.difference);g.uniform1i(this.uniform(p,'smoothMode'),+(this.settings.sampling==='smooth'));g.bindFramebuffer(g.FRAMEBUFFER,this.framebuffer);}
  do {
   const serial=this.pending.pop()!,slot=(serial-1)%this.capacity,row=this.slots[slot];if(!row||row.serial!==serial||row.revision===this.revision)continue;
   const index=this.rows.length-1-(this.serial-serial);if(index<0)continue;
   const taps=spectrumTaps(this.rows,index,this.settings);
   if(g){const p=this.programs[0];this.tapSlots.fill(0);this.tapWeights.fill(0);taps.forEach((t,i)=>{this.tapSlots[i]=t.slot;this.tapWeights[i]=t.weight;});
    g.uniform1i(this.uniform(p,'tapCount'),taps.length);g.uniform1iv(this.uniform(p,'slots[0]'),this.tapSlots);g.uniform1fv(this.uniform(p,'weights[0]'),this.tapWeights);
    g.framebufferTextureLayer(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,this.textures[1],0,Math.floor(slot/this.pageHeight));g.viewport(0,slot%this.pageHeight,this.width,1);g.drawArrays(g.TRIANGLES,0,3);
   }else{
    const values=new Float32Array(this.width),channel=+this.settings.difference;
    for(let x=0;x<this.width;++x){const c=this.columns[x];let value=0;
     for(const tap of taps){const raw=this.cpuRaw.get(tap.slot);if(!raw)continue;let p=0;if(this.settings.sampling==='smooth'&&c.high-c.low===2)p=raw[c.low*2+channel]*c.lowWeight+raw[(c.low+1)*2+channel]*c.highWeight;else{for(let bin=c.low;bin<c.high;++bin)p+=raw[bin*2+channel];p/=c.high-c.low;}value+=p*tap.weight;}values[x]=value;
    }this.cpuProjected.set(slot,values);
   }
   row.revision=this.revision;++count;++this.counters.projected;
  }while(this.pending.length&&count<64&&performance.now()-start<budgetMs);
  if(g){g.bindFramebuffer(g.FRAMEBUFFER,null);if(count){this.fence=g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE,0);g.flush();}}
 }
 draw(audible:number,generation:number){
  if(!this.settings)return;
  this.timeData.fill(0);
  if(this.generation===generation)for(let y=0;y<this.height;++y){const p=spectrumTimeRow(this.rows,audible,y,this.height,this.settings,this.timePlan);if(!p)continue;
   let valid=true;for(let i=p.first;i<=p.last;++i)if(this.rows[i].revision!==this.revision){valid=false;break;}if(!valid)continue;
   if(p.phase&&this.slots[p.next]?.revision!==this.revision){p.phase=0;p.lowWeight=1;}
   const at=y*8;this.timeData[at]=p.slot;this.timeData[at+1]=p.count;this.timeData[at+2]=p.next;this.timeData[at+3]=p.phase;this.timeData[at+4]=p.lowWeight;
  }
  const g=this.gl;
  if(g){const p=this.programs[1];g.bindFramebuffer(g.FRAMEBUFFER,null);g.viewport(0,0,this.width,this.height);g.useProgram(p);
   this.bind(0,g.TEXTURE_2D_ARRAY,this.textures[1]);this.bind(1,g.TEXTURE_2D,this.textures[3]);g.texSubImage2D(g.TEXTURE_2D,0,0,0,2,this.height,g.RGBA,g.FLOAT,this.timeData);this.bind(2,g.TEXTURE_2D,this.textures[4]);
   for(const [name,value]of [['projectedData',0],['timeRows',1],['palette',2],['pageHeight',this.pageHeight],['capacity',this.capacity]] as const)g.uniform1i(this.uniform(p,name),value);
   g.uniform1f(this.uniform(p,'floorDb'),this.settings.floorDb);g.uniform1f(this.uniform(p,'ceilingDb'),this.settings.ceilingDb);g.drawArrays(g.TRIANGLES,0,3);
  }else if(this.image){const data=this.image.data,s=this.settings;
   for(let y=0;y<this.height;++y){const at=y*8,slot=this.timeData[at],count=this.timeData[at+1],next=this.timeData[at+2],phase=this.timeData[at+3],lowWeight=this.timeData[at+4];
    for(let x=0;x<this.width;++x){const out=(y*this.width+x)*4;if(!count){data[out]=2;data[out+1]=5;data[out+2]=12;data[out+3]=255;continue;}let power=0;for(let i=0;i<count;++i)power+=this.cpuProjected.get((slot+i)%this.capacity)?.[x]??0;power/=count;if(phase)power=power*lowWeight+(this.cpuProjected.get(next)?.[x]??0)*phase;const db=10*Math.log10(Math.max(1e-12,power)),index=Math.max(0,Math.min(255,Math.floor((db-s.floorDb)/Math.max(1,s.ceilingDb-s.floorDb)*255)))*4;data[out]=this.paletteData[index];data[out+1]=this.paletteData[index+1];data[out+2]=this.paletteData[index+2];data[out+3]=255;}
   }this.context!.putImageData(this.image,0,0);
  }++this.counters.draws;
 }
 stats():SpectrumRenderStats{return {backend:this.gl?'WebGL 2':'Canvas fallback',...this.counters,pending:this.pending.length};}
 /** Diagnostic-only numeric readback. Never used during live rendering. */
 readProjected(slot:number){
  if(!this.gl)return this.cpuProjected.get(slot)?.slice()??new Float32Array(this.width);
  const g=this.gl;g.bindFramebuffer(g.FRAMEBUFFER,this.framebuffer);g.framebufferTextureLayer(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,this.textures[1],0,Math.floor(slot/this.pageHeight));
  const data=new Float32Array(this.width*4);g.readPixels(0,slot%this.pageHeight,this.width,1,g.RGBA,g.FLOAT,data);g.bindFramebuffer(g.FRAMEBUFFER,null);
  if(g.getError()!==g.NO_ERROR)throw new Error('Spectrum numeric readback failed');return Float32Array.from({length:this.width},(_,i)=>data[i*4]);
 }
 dispose(){const g=this.gl;if(g){if(this.fence)g.deleteSync(this.fence);for(const t of this.textures)g.deleteTexture(t);for(const p of this.programs)g.deleteProgram(p);g.deleteFramebuffer(this.framebuffer);}this.resetRows();this.textures=[];this.programs=[];}
}
