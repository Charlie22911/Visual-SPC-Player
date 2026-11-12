import { describe,it,expect } from 'vitest';
import { spectrumColor, spectrumColumns, spectrumTaps, spectrumTimeRow } from '../src/spectrum/displayMath';
import { defaultSpectrumSettings as defaults } from '../src/spectrum/settings';
describe('numeric spectrum presentation',()=>{
 it('uses positive frequency weights, including near-bin boundaries',()=>{
  const columns=spectrumColumns({...defaults,logarithmic:false},1025);
  for(const c of columns) { expect(c.lowWeight).toBeGreaterThanOrEqual(0); expect(c.highWeight).toBeGreaterThanOrEqual(0); expect(c.lowWeight+c.highWeight).toBeCloseTo(1,6); }
 });
 it('never filters across missing analysis rows or segments',()=>{
  const rows=[{nativeFrame:2048,sequence:1,segment:1,slot:0},{nativeFrame:2304,sequence:2,segment:1,slot:1},{nativeFrame:2816,sequence:4,segment:1,slot:2}];
  expect(spectrumTaps(rows,2,defaults).map(t=>t.slot)).toEqual([2]);
  expect(spectrumTaps(rows,1,defaults).length).toBe(2);
 });
 it('gates future rows and uses the same causal support for smooth endpoints',()=>{
  const rows=[{nativeFrame:2048,sequence:1,segment:1,slot:0},{nativeFrame:2304,sequence:2,segment:1,slot:1}];
  expect(spectrumTimeRow(rows,2000,0,100,defaults)).toBeNull();
  const held=spectrumTimeRow(rows,2200,0,100,defaults)!;
  expect(held.phase).toBe(0); expect(held.slot).toBe(0);
  const blend=spectrumTimeRow(rows,2800,1,100,{...defaults,seconds:2})!;
  expect(blend.phase).toBeGreaterThan(0); expect(blend.next).toBe(1);
 });
 it('matches native palette endpoints and difference grayscale',()=>{
  expect(spectrumColor(0,'green')).toEqual([0,0,0,255]);
  expect(spectrumColor(255,'green')).toEqual([255,255,235,255]);
  expect(spectrumColor(123,'grayscale')).toEqual([123,123,123,255]);
 });
});
