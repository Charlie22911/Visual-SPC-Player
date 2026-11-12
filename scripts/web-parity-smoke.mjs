import {strict as assert} from 'node:assert';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions,artifactPath} from './browser-environment.mjs';
const url=process.env.SPC_PREVIEW_URL||'http://127.0.0.1:4173/';
const image=process.env.SPC_TEST_FILE?new Uint8Array(await readFile(process.env.SPC_TEST_FILE)):new Uint8Array(0x10180);
if(!process.env.SPC_TEST_FILE){image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));image.set([0x1a,0x1a,0x1a,0x1e],0x21);image[0x26]=2;image.set([0xac,0x34,0x12,0x2f,0xfb],0x300);}
const fixture=(title)=>{const copy=image.slice();copy.fill(0,0x2e,0x4e);copy.set(new TextEncoder().encode(title),0x2e);return{name:title+'.spc',mimeType:'application/octet-stream',buffer:Buffer.from(copy)};};
const browser=await chromium.launch(browserLaunchOptions),failures=[],report=[];
function runtime(){
 const el=document.querySelector('.app-shell');let f=el?.[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];
 for(;f;f=f.return)for(let h=f.memoizedState;h&&typeof h==='object';h=h.next){const v=Array.isArray(h.memoizedState)?h.memoizedState[0]:h.memoizedState;if(v?.spectrumStats&&v?.spectrumClock)return v;}
 throw new Error('Player audio engine was not found');
}
try{
 for(const [width,height,dpr]of [[1440,1000,1],[390,844,2]]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr,acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});await page.evaluate(`window.playerRuntime=${runtime.toString()}`);
  await page.evaluate(()=>window.playerRuntime().setVolume(0));
  assert.deepEqual(await page.locator('.view-tabs button').allTextContents(),['ARAM','Voices','DSP','Spectrogram','Track','Settings','About']);
  await page.locator('input[accept=".spc"]').setInputFiles(fixture('Parity fixture'));
  await page.locator('.track-list button').filter({hasText:'Parity fixture'}).first().click();
  await page.locator('.now-playing strong').filter({hasText:'Parity fixture'}).waitFor();
  const hide=page.getByRole('button',{name:'Collapse library',exact:true});if(await hide.isVisible())await hide.click();
  await page.getByRole('button',{name:'Spectrogram',exact:true}).click();
  await page.waitForFunction(()=>window.playerRuntime().spectrumStats().active&&window.playerRuntime().spectrumStats().analysed>20,{timeout:15000});
  await page.getByLabel('Spectrogram preset').selectOption('frequency');
  await page.getByLabel('Spectrogram sampling').selectOption('area');
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.spectrum-plot canvas').count(),1);
  const before=await page.evaluate(()=>window.playerRuntime().spectrumStats());
  await page.getByRole('button',{name:'Voices',exact:true}).click();await page.waitForTimeout(150);
  const stopped=await page.evaluate(()=>window.playerRuntime().spectrumStats());await page.waitForTimeout(450);
  assert.deepEqual(await page.evaluate(()=>window.playerRuntime().spectrumStats()),stopped);assert.equal(stopped.active,false);
  assert.equal(await page.locator('.spectrum-plot canvas').count(),0);
  await page.getByRole('button',{name:'Spectrogram',exact:true}).click();
  await page.waitForFunction(()=>window.playerRuntime().spectrumStats().analysed>5);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForTimeout(250);
  const paused=await page.evaluate(()=>window.playerRuntime().spectrumClock().nativeFrame);await page.waitForTimeout(500);
  assert(Math.abs((await page.evaluate(()=>window.playerRuntime().spectrumClock().nativeFrame))-paused)<1);
  await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForTimeout(30);
  assert((await page.evaluate(()=>window.playerRuntime().spectrumClock().nativeFrame))-paused<16000);
  const layout=await page.evaluate(()=>{const footer=document.querySelector('.app-footer').getBoundingClientRect();return{body:document.documentElement.scrollHeight,inner:innerHeight,bottom:footer.bottom,canvas:document.querySelector('.spectrum-plot canvas').getBoundingClientRect().height};});
  assert(layout.body<=layout.inner+1&&layout.bottom<=layout.inner+1);assert(layout.canvas>30);
  await page.screenshot({path:artifactPath(`web-parity-${width}.png`)});
  await page.getByRole('button',{name:'About',exact:true}).click();
  assert(await page.getByText('KISS FFT',{exact:false}).count()>0);
  report.push({width,height,dpr,layout,before,stopped});await context.close();
 }
 // The portable document must initialize analysis without fetching application assets.
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),network=[];
 page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});page.on('pageerror',e=>failures.push(e.message));
 await page.goto(pathToFileURL(resolve('Visual-SPC-Player.html')).href,{waitUntil:'load'});await page.evaluate(`window.playerRuntime=${runtime.toString()}`);
 await page.evaluate(()=>window.playerRuntime().setVolume(0));
 await page.locator('input[accept=".spc"]').setInputFiles(fixture('Portable parity'));
 await page.locator('.track-list button').filter({hasText:'Portable parity'}).first().click();
 const hide=page.getByRole('button',{name:'Collapse library',exact:true});if(await hide.isVisible())await hide.click();
 await page.getByRole('button',{name:'Spectrogram',exact:true}).click();
 await page.waitForFunction(()=>window.playerRuntime().spectrumStats().analysed>10,{timeout:15000});
 const embedded=await page.evaluate(()=>window.__SPC_STANDALONE_ASSETS__);
 assert(embedded.spectrumWasmBase64.length>1000&&embedded.projectSourceBase64.length>100000);assert.deepEqual(network,[]);
 await context.close();assert.deepEqual(failures,[]);
 await writeFile(artifactPath('web-parity-report.json'),JSON.stringify(report,null,2));console.log('Hosted/mobile/portable spectrum, inactive lifecycle and fixed-layout checks passed');
}finally{await browser.close();}
