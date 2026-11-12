import type { SpectrumSettings } from './types';
export type SpectrumMeta={nativeFrame:number;sequence:number;segment:number;slot:number};
export type SpectrumColumn={low:number;high:number;highWeight:number;lowWeight:number};
export function spectrumColor(level:number,palette:SpectrumSettings['palette']):[number,number,number,number] {
 const n=Math.max(0,Math.min(255,Math.floor(level)));
 if(palette==='grayscale')return[n,n,n,255];
 const ramp=palette==='heat'?[[0,0,0],[41,12,77],[116,22,89],[208,50,44],[255,159,45],[255,255,224]]:[[0,0,0],[0,30,20],[0,92,48],[40,164,65],[185,222,83],[255,255,235]];
 const segment=n===255?4:Math.floor(n/51),fraction=n-segment*51;
 return [0,1,2].map(c=>Math.floor((ramp[segment][c]*(51-fraction)+ramp[segment+1][c]*fraction+25)/51)).concat(255) as [number,number,number,number];
}
export const spectrumFrequency=(fraction:number,logarithmic:boolean)=>logarithmic?20*Math.pow(800,fraction):16000*fraction;
export function spectrumColumns(s:SpectrumSettings,width:number):SpectrumColumn[] {
 const bins=s.fftSize/2+1,last=bins-1;
 return Array.from({length:width},(_,x)=>{
  let low=Math.min(last,Math.floor(spectrumFrequency(x/width,s.logarithmic)*s.fftSize/32000));
  let high=Math.max(low+1,Math.min(bins,Math.ceil(spectrumFrequency((x+1)/width,s.logarithmic)*s.fftSize/32000)));
  let fraction=0;
  if(s.sampling==='smooth') {const bin=spectrumFrequency((x+.5)/width,s.logarithmic)*s.fftSize/32000;low=Math.min(last,Math.floor(bin));high=Math.min(bins,low+2);fraction=bin-Math.floor(bin);}
  else if(s.sampling==='nearest') {low=Math.min(last,Math.floor(spectrumFrequency((x+.5)/width,s.logarithmic)*s.fftSize/32000+.5));high=low+1;}
  return {low,high,highWeight:fraction,lowWeight:1-fraction};
 });
}
export const spectrumContinuous=(a:SpectrumMeta,b:SpectrumMeta,hop:number)=>b.segment===a.segment&&b.sequence===a.sequence+1&&b.nativeFrame===a.nativeFrame+hop;
export function spectrumTaps(rows:readonly SpectrumMeta[],endpoint:number,s:SpectrumSettings) {
 const radius=s.temporal?Math.floor(s.temporalMs*32/s.hopSize):0,step=Math.max(1,Math.ceil(radius/8));
 let support=0;while(support<radius&&support<endpoint&&spectrumContinuous(rows[endpoint-support-1],rows[endpoint-support],s.hopSize))++support;
 const taps=[];let sum=0;
 for(let age=0;age<=support;age+=step) {const weight=s.temporal?Math.exp(-age*s.hopSize/(Math.max(1,s.temporalMs)*32)):1;sum+=weight;taps.push({slot:rows[endpoint-age].slot,weight});}
 for(const t of taps)t.weight/=sum;return taps;
}
export type SpectrumTimePlan={slot:number;count:number;next:number;phase:number;lowWeight:number;first:number;last:number};
export function spectrumTimeRow(rows:readonly SpectrumMeta[],audible:number,y:number,height:number,s:SpectrumSettings,output?:SpectrumTimePlan) {
 const end=audible-y*s.seconds*32000/height,begin=end-s.seconds*32000/height;
 let a=0,b=rows.length;while(a<b){const m=(a+b)>>>1;if(rows[m].nativeFrame<=end)a=m+1;else b=m;}
 const i=a-1;if(i<0||end-rows[i].nativeFrame>s.hopSize*2)return null;
 let first=i;
 if(s.sampling==='area')while(first>0&&rows[first-1].nativeFrame>=begin&&spectrumContinuous(rows[first-1],rows[first],s.hopSize))--first;
 const phase=s.sampling==='smooth'&&a<rows.length&&rows[a].nativeFrame<=audible&&spectrumContinuous(rows[i],rows[a],s.hopSize)?Math.max(0,Math.min(1,(end-rows[i].nativeFrame)/s.hopSize)):0;
 const plan=output??{} as SpectrumTimePlan;
 plan.slot=rows[first].slot;plan.count=i-first+1;plan.next=phase?rows[a].slot:rows[i].slot;plan.phase=phase;plan.lowWeight=1-phase;plan.first=first;plan.last=i;return plan;
}
