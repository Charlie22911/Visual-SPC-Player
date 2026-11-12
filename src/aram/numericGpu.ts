import { activityPalette, bitPalette, bytePalette, metricPalette, type PalettePreset } from './palettes';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type AramMode, type MemorySampling } from './types';
import type { ReducedRow } from './metrics';
import type { Viewport } from './viewport';

const vertex = `#version 300 es
void main() { vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.-1.,0,1); }`;
const fragment = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D ramTex, accessTex, heldTex, flagsTex;
uniform sampler2D entropyTex, rowsTex, paletteTex, continuityTex;
uniform ivec2 sourceSize, outputSize;
uniform int waterfall, newestSlot, measurement, bits, changes, previousValid, persistence, underlay, sampling, temporalRadius;
uniform vec2 origin;
uniform float cellSize;
out vec4 outputColor;
struct Cell { float value; float background; int kind; int held; int changed; int valid; };
Cell emptyCell() { return Cell(0.,0.,0,0,0,0); }
Cell loadCell(ivec2 p) {
  if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,sourceSize))) return emptyCell();
  if(waterfall!=0) {
    int slot=(newestSlot+sourceSize.y-p.y)%sourceSize.y;
    uint flags=texelFetch(flagsTex,ivec2(p.x,slot),0).r;
    if((flags&1u)==0u) return emptyCell();
    vec2 row=texelFetch(rowsTex,ivec2(p.x,slot),0).rg;
    return Cell(row.x,row.y,measurement==0?int(row.x):0,0,int((flags>>1u)&1u),1);
  }
  int a=bits!=0?(p.y/2)*256+p.x/4:p.y*256+p.x;
  int lane=bits!=0?(p.y%2)*4+p.x%4:0;
  ivec2 address=ivec2(a%256,a/256);
  int value=int(texelFetch(ramTex,address,0).r);
  int held=int(texelFetch(heldTex,address,0).r);
  int word=a/8, shift=a%8, kind=0;
  for(int k=0;k<3;k++) kind|=int((texelFetch(accessTex,ivec2(word%256,word/256+k*32),0).r>>uint(shift))&1u)<<k;
  float v=bits!=0?float((value>>(7-lane))&1):float(value);
  if(measurement==2) v=texelFetch(entropyTex,ivec2(a/256,lane),0).r;
  return Cell(v,v,kind,held,v!=0.?1:0,1);
}
Cell filteredCell(ivec2 p) {
  Cell cell=loadCell(p);
  if(waterfall==0||temporalRadius<1||cell.valid==0) return cell;
  int stepSize=max(1,(temporalRadius+7)/8);
  int available=min(temporalRadius,int(texelFetch(continuityTex,ivec2(0,p.y),0).r));
  float sum=(measurement==0?cell.background:cell.value)*2., norm=2.;
  // The tiny chronology texture bounds taps to the nearest missing band.
  // At most eight numeric fetches, without jumping over a capture gap.
  for(int age=stepSize;age<=available;age+=stepSize) {
    Cell older=loadCell(p+ivec2(0,age)); if(older.valid==0) break;
    float w=2.*float(temporalRadius+stepSize-age)/float(temporalRadius+stepSize);
    sum+=(measurement==0?older.background:older.value)*w; norm+=w;
  }
  if(measurement==0) cell.background=sum/norm; else cell.value=sum/norm;
  return cell;
}
vec3 palette(int table,float index) { return texelFetch(paletteTex,ivec2(int(floor(clamp(index,0.,255.)+.50001)),table),0).rgb; }
vec3 colorCell(Cell cell) {
  if(measurement==0) {
    int kind=persistence!=0&&underlay==0&&waterfall==0?cell.held:cell.kind;
    vec3 fg=palette(3,float(kind)); if(underlay==0) return fg;
    vec3 bg=palette(bits!=0?1:0,cell.background*(bits!=0?255.:1.));
    return floor((bg*.35*(kind!=0?.08:1.)+(kind!=0?fg*.92:vec3(0)))*255.+.5)/255.;
  }
  if(measurement==2) return palette(2,cell.value/(bits!=0?1.:8.)*255.);
  if(changes!=0&&previousValid==0&&waterfall==0) return palette(2,(int(gl_FragCoord.x)&8)!=0?20.:35.);
  float index=cell.value*(bits!=0?255.:1.);
  if((changes!=0&&cell.changed!=0)||(bits!=0&&cell.value>0.)) index=max(1.,index);
  vec3 result=palette(bits!=0?1:0,index);
  if(waterfall==0&&persistence!=0&&changes==0&&cell.held!=0) result=result*.55+palette(3,float(cell.held))*.45;
  return result;
}
void main() {
  vec2 pixel=vec2(gl_FragCoord.x,float(outputSize.y)-gl_FragCoord.y);
  vec2 ratio=waterfall!=0?vec2(sourceSize)/vec2(outputSize):vec2(1./cellSize);
  vec2 center=waterfall!=0?pixel*ratio:(pixel-origin)/cellSize;
  vec3 missing=waterfall!=0?vec3(16,23,34)/255.:vec3(2,5,12)/255.;
  bool outside=any(lessThan(center,vec2(0)))||any(greaterThanEqual(center,vec2(sourceSize)));
  if(outside&&(waterfall!=0||sampling!=2||any(lessThanEqual(center+ratio*.5,vec2(0)))||any(greaterThanEqual(center-ratio*.5,vec2(sourceSize))))) { outputColor=vec4(missing,1); return; }
  Cell anchor=filteredCell(clamp(ivec2(floor(center)),ivec2(0),sourceSize-1));
  if(sampling==0) { outputColor=vec4(anchor.valid!=0?colorCell(anchor):missing,1); return; }
  if(anchor.valid==0) { outputColor=vec4(missing,1); return; }
  bool smoothMode=sampling==1;
  vec2 lo=smoothMode?floor(center-.5):waterfall==0?center-ratio*.5:mix(floor(center),center-ratio*.5,greaterThan(ratio,vec2(1)));
  vec2 hi=smoothMode?lo+2.:waterfall==0?center+ratio*.5:mix(lo+1.,center+ratio*.5,greaterThan(ratio,vec2(1)));
  Cell sum=emptyCell(); float total=0., valid=0.;
  for(int y=int(floor(lo.y));y<int(ceil(hi.y));y++) for(int x=int(floor(lo.x));x<int(ceil(hi.x));x++) {
    vec2 pos=vec2(x,y);
    vec2 weights=smoothMode?max(vec2(0),1.-abs(center-.5-pos)):max(vec2(0),min(hi,pos+1.)-max(lo,pos));
    float w=weights.x*weights.y; if(w<=0.) continue; total+=w;
    ivec2 tap=ivec2(x,y); if(smoothMode) tap=clamp(tap,ivec2(0),sourceSize-1);
    Cell next=filteredCell(tap); if(next.valid==0) continue;
    valid+=w; sum.value+=next.value*w; sum.background+=next.background*w;
    sum.kind|=next.kind; sum.held|=next.held; sum.changed|=next.changed;
  }
  if(valid<=0.) { outputColor=vec4(missing,1); return; }
  sum.value/=valid; sum.background/=valid;
  outputColor=vec4(mix(missing,colorCell(sum),clamp(valid/total,0.,1.)),1);
}`;

export type NumericGpuConfig = { mode: AramMode; palette: PalettePreset; activityByteBackground?: boolean; sampling?: MemorySampling; temporal?: boolean; temporalMs?: number; framesPerBand?: number };
// Numeric textures are sampled explicitly. Hardware linear RGB filtering and
// mipmaps would average palette colors rather than memory measurements.
export class NumericGpu {
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[] = [];
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private palette: PalettePreset | null = null;
  private width = 0;
  private height = 0;
  private row = new Float32Array(0);
  private flags = new Uint8Array(0);
  private validSlots = new Uint8Array(0);
  private continuity = new Float32Array(0);
  private continuityDirty = true;
  private continuityBand = -1;
  private constructor(readonly canvas: HTMLCanvasElement, readonly gl: WebGL2RenderingContext, readonly waterfall: boolean) {
    const compile = (kind: number, source: string) => {
      const shader=gl.createShader(kind)!; gl.shaderSource(shader,source); gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) { const reason=gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(reason ?? 'Memory shader compilation failed'); }
      return shader;
    };
    const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
    this.program=gl.createProgram()!; gl.attachShader(this.program,vs); gl.attachShader(this.program,fs); gl.linkProgram(this.program); gl.deleteShader(vs); gl.deleteShader(fs);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) ?? 'Memory shader linking failed');
    gl.useProgram(this.program); gl.bindVertexArray(gl.createVertexArray()); gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    ['ramTex','accessTex','heldTex','entropyTex','rowsTex','flagsTex','paletteTex','continuityTex'].forEach((name,unit)=> {
      this.textures.push(gl.createTexture()!); this.bind(unit); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); gl.uniform1i(this.location(name),unit);
      // Every active sampler must be complete, including the other geometry.
      const integer=[0,1,2,5].includes(unit); gl.texImage2D(gl.TEXTURE_2D,0,integer?gl.R8UI:gl.R32F,1,1,0,integer?gl.RED_INTEGER:gl.RED,integer?gl.UNSIGNED_BYTE:gl.FLOAT,null);
    });
    if(!waterfall) {
      for(const [unit,w,h] of [[0,256,256],[1,256,96],[2,256,256]]) { this.bind(unit); gl.texImage2D(gl.TEXTURE_2D,0,gl.R8UI,w,h,0,gl.RED_INTEGER,gl.UNSIGNED_BYTE,null); }
      this.bind(3); gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,256,8,0,gl.RED,gl.FLOAT,null);
    }
  }
  static create(canvas: HTMLCanvasElement, waterfall: boolean): NumericGpu | null {
    try { const gl=canvas.getContext('webgl2',{ alpha:false, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:true });
      if(!gl||typeof gl.texImage2D!=='function') return null;
      return new NumericGpu(canvas,gl,waterfall);
    } catch { return null; }
  }
  private location(name: string) { if(!this.uniforms.has(name)) this.uniforms.set(name,this.gl.getUniformLocation(this.program,name)); return this.uniforms.get(name)!; }
  private bind(unit: number) { this.gl.activeTexture(this.gl.TEXTURE0+unit); this.gl.bindTexture(this.gl.TEXTURE_2D,this.textures[unit]); }
  private integer(name: string,value: number) { this.gl.uniform1i(this.location(name),value); }
  configureRows(width: number,height: number) {
    const gl=this.gl; if(width>gl.getParameter(gl.MAX_TEXTURE_SIZE)||height>gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new RangeError('Memory plot exceeds graphics texture capacity');
    this.width=width; this.height=height; this.row=new Float32Array(width*2); this.flags=new Uint8Array(width);
    this.validSlots=new Uint8Array(height); this.continuity=new Float32Array(height); this.continuityDirty=true;
    this.bind(4); gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,width,height,0,gl.RG,gl.FLOAT,null);
    this.bind(5); gl.texImage2D(gl.TEXTURE_2D,0,gl.R8UI,width,height,0,gl.RED_INTEGER,gl.UNSIGNED_BYTE,new Uint8Array(width*height));
    this.bind(7); gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,1,height,0,gl.RED,gl.FLOAT,this.continuity);
  }
  clearRows() { const gl=this.gl; this.validSlots.fill(0); this.continuityDirty=true; this.bind(5); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height,gl.RED_INTEGER,gl.UNSIGNED_BYTE,new Uint8Array(this.width*this.height)); }
  invalidateRow(band: number) { const gl=this.gl,slot=((band%this.height)+this.height)%this.height; this.validSlots[slot]=0; this.continuityDirty=true; this.flags.fill(0); this.bind(5); gl.texSubImage2D(gl.TEXTURE_2D,0,0,slot,this.width,1,gl.RED_INTEGER,gl.UNSIGNED_BYTE,this.flags); }
  uploadRow(band: number,row: ReducedRow,columns: number) {
    const gl=this.gl,slot=((band%this.height)+this.height)%this.height;
    this.validSlots[slot]=row.valid?1:0; this.continuityDirty=true;
    for(let x=0;x<columns;x++) for(let lane=0;lane<row.lanes;lane++) { const dst=x*row.lanes+lane,src=lane*columns+x;
      this.row[dst*2]=row.values[src]; this.row[dst*2+1]=row.byteValues?.[x]??row.bitValues?.[src]??0; this.flags[dst]=row.valid?1|(row.anyChange?.[x]?2:0):0;
    }
    this.bind(4); gl.texSubImage2D(gl.TEXTURE_2D,0,0,slot,this.width,1,gl.RG,gl.FLOAT,this.row);
    this.bind(5); gl.texSubImage2D(gl.TEXTURE_2D,0,0,slot,this.width,1,gl.RED_INTEGER,gl.UNSIGNED_BYTE,this.flags);
  }
  uploadMap(ram: Uint8Array,access: Uint8Array,held: Uint8Array,entropy: Float32Array) {
    const gl=this.gl;
    for(const [unit,data,w,h] of [[0,ram,256,256],[1,access,256,96],[2,held,256,256]] as const) { this.bind(unit); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,gl.RED_INTEGER,gl.UNSIGNED_BYTE,data); }
    this.bind(3); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,8,gl.RED,gl.FLOAT,entropy);
  }
  draw(config: NumericGpuConfig,outputWidth: number,outputHeight: number,newestBand = 0,viewport?: Viewport,previousValid = true,persistence = false) {
    const gl=this.gl; gl.useProgram(this.program);
    if(this.canvas.width!==outputWidth) this.canvas.width=outputWidth; if(this.canvas.height!==outputHeight) this.canvas.height=outputHeight;
    gl.viewport(0,0,outputWidth,outputHeight);
    if(this.waterfall&&(this.continuityDirty||this.continuityBand!==newestBand)) {
      let run=0;
      for(let y=this.height-1;y>=0;y--) { const slot=(((newestBand-y)%this.height)+this.height)%this.height; run=this.validSlots[slot]?run+1:0; this.continuity[y]=Math.max(0,run-1); }
      this.bind(7); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,1,this.height,gl.RED,gl.FLOAT,this.continuity);
      this.continuityDirty=false; this.continuityBand=newestBand;
    }
    if(this.palette!==config.palette) {
      const data=new Uint8Array(256*4*4),off=bitPalette(false,config.palette),on=bitPalette(true,config.palette);
      for(let i=0;i<256;i++) { data.set(bytePalette(i,config.palette),i*4); data.set([0,1,2].map(c=>Math.round(off[c]+(on[c]-off[c])*i/255)).concat(255),(256+i)*4); data.set(metricPalette(i/255,config.palette),(512+i)*4); data.set(activityPalette(i&7,config.palette),(768+i)*4); }
      this.bind(6); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,256,4,0,gl.RGBA,gl.UNSIGNED_BYTE,data); this.palette=config.palette;
    }
    const bits=isBitMode(config.mode); this.integer('waterfall',this.waterfall?1:0); this.integer('measurement',isActivityMode(config.mode)?0:isEntropyMode(config.mode)?2:1); this.integer('bits',bits?1:0);
    this.integer('changes',isXorMode(config.mode)?1:0); this.integer('previousValid',previousValid?1:0); this.integer('persistence',persistence?1:0); this.integer('underlay',config.activityByteBackground?1:0);
    this.integer('sampling',config.sampling==='smooth'?1:config.sampling==='area'?2:0);
    const radius=config.temporal?Math.max(1,Math.round(Math.max(10,Math.min(200,config.temporalMs??50))*32/(config.framesPerBand??1))):0; this.integer('temporalRadius',radius);
    this.integer('newestSlot',((newestBand%this.height)+this.height)%this.height||0);
    gl.uniform2i(this.location('sourceSize'),this.waterfall?this.width:bits?1024:256,this.waterfall?this.height:bits?512:256); gl.uniform2i(this.location('outputSize'),outputWidth,outputHeight);
    gl.uniform2f(this.location('origin'),viewport?.offsetX??0,viewport?.offsetY??0); gl.uniform1f(this.location('cellSize'),viewport?.scale??1);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  dispose() { for(const texture of this.textures) this.gl.deleteTexture(texture); this.gl.deleteProgram(this.program); }
}
