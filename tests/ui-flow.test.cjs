const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function element(id){
  const classes=new Set();
  return {id,textContent:'--',innerHTML:'',dataset:{},style:{},hidden:false,disabled:false,children:[],listeners:{},
    classList:{add:(...x)=>x.forEach(a=>classes.add(a)),remove:(...x)=>x.forEach(a=>classes.delete(a)),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},
    addEventListener(name,fn){this.listeners[name]=fn},setAttribute(){},removeAttribute(){},appendChild(e){this.children.push(e)},focus(){},querySelector(){return element('child')},querySelectorAll(){return []},getBoundingClientRect(){return {width:500,height:300}}};
}
function harness(engine, options={}){
  let time=0;const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id)};
  const document={getElementById:get,querySelector:s=>get(s),querySelectorAll:()=>[],createElement:()=>element('new'),createElementNS:()=>element('svg'),addEventListener(){},activeElement:null};
  const context={document,console,AbortController,DOMException,Uint8Array,performance:{now:()=>time},
    crypto:{getRandomValues:a=>a.fill(42)},localStorage:{getItem:k=>k==='jj:autoMode'?(options.auto?'true':'false'):null,setItem(){}},
    fetch:async(...args)=>{time+=options.fetchMs?options.fetchMs(args[0]):100;if(options.fetch)return options.fetch(...args);throw Error('network deliberately disabled')},
    setTimeout:fn=>{queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){},
    requestAnimationFrame:fn=>{time+=1000;queueMicrotask(()=>fn(time));return 1},
    matchMedia:()=>({matches:true}),innerWidth:1000,innerHeight:800,devicePixelRatio:1,
    addEventListener(){},JJMeasurement:engine,__JJ_TEST__:true};
  context.window=context; context.globalThis=context;
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  let script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('async function runTest'));
  vm.runInNewContext(script,context);
  return {context,get,run:()=>context.JJTestHooks.runTest()};
}
// Added integration assertions below after engine wiring settles.
module.exports={harness};
test('document preserves complete markup, engine inclusion and parseable inline script',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  for(const pattern of [/<\/style>/,/<body\b/,/<\/body>/,/<main\b/,/<\/main>/,/<script[^>]+src=["'](?:\.\/)?measurement-engine\.js["']/,/id="btnStart"/,/id="statusMsg"/,/id="btnStop"/]) assert.ok(pattern.test(html),`missing document structure ${pattern}`);
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});
function goodEngine(){return {ping:async()=>({ms:12,jitter:2}),download:async()=>({mbps:80,bytes:100000,measuredMs:10000,elapsedMs:11500}),upload:async()=>({mbps:20,bytes:25000,acknowledgedBytes:25000,measuredMs:10000,elapsedMs:11500})};}
test('successful complete run shows all metrics, success and restores controls',async()=>{
  const h=harness(goodEngine());await h.run();
  assert.equal(h.get('dlVal').textContent,'80');assert.equal(h.get('ulVal').textContent,'20');
  assert.ok(h.get('.card').classList.contains('done-glow'));assert.match(h.get('statusMsg').innerHTML,/complete/);
  assert.equal(h.get('btnStart').disabled,false);assert.equal(h.get('btnChangeServer').disabled,false);assert.equal(h.get('btnStop').hidden,true);
});
test('failed upload preserves download but never displays success',async()=>{
  const engine=goodEngine();engine.upload=async()=>{throw Error('Upload returned HTTP 500')};const h=harness(engine);await h.run();
  assert.equal(h.get('dlVal').textContent,'80');assert.equal(h.get('ulVal').textContent,'--');
  assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.match(h.get('statusMsg').innerHTML,/unavailable/);
});
test('server destination stays locked during transfer and stop cancels without success',async()=>{
  const engine=goodEngine();let firstUrl,secondUrl,ctrlSignal,release;
  engine.download=async options=>{firstUrl=options.url(123);ctrlSignal=options.signal;await new Promise(r=>release=r);secondUrl=options.url(123);if(options.signal.aborted)throw new DOMException('Stopped','AbortError');return {mbps:80,bytes:1,measuredMs:1000}};
  const h=harness(engine);const pending=h.run();for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(h.get('btnChangeServer').disabled,true);assert.equal(h.get('btnStop').hidden,false);
  const state=h.context.JJTestHooks.getState();
  state.activeServer.type='librespeed';state.activeServer.base='https://changed.example';
  assert.ok(Object.isFrozen(state.testServer),'snapshot must be immutable');
  h.get('btnStop').listeners.click();assert.equal(ctrlSignal.aborted,true);release();await pending;
  assert.equal(new URL(firstUrl).hostname,new URL(secondUrl).hostname);assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.match(h.get('statusMsg').innerHTML,/stopped/);
  assert.equal(h.get('btnStart').disabled,false);
});
test('page initialization performs no external network measurements',()=>{
  let calls=0;harness(goodEngine(),{fetch:async()=>{calls++;throw Error('unexpected request')}});assert.equal(calls,0);
});
test('automatic selection compares bounded trial throughput, then uses selected destination for both phases',async()=>{
  const engine=goodEngine(),destinations=[];
  engine.download=async o=>{destinations.push(new URL(o.url(100)).hostname);return {mbps:80,bytes:100,measuredMs:1000}};
  engine.upload=async o=>{destinations.push(new URL(o.url()).hostname);return {mbps:20,bytes:100,measuredMs:1000}};
  let trials=0;
  const h=harness(engine,{auto:true,fetchMs:url=>url.includes('cloudflare')?200:100,fetch:async()=>{trials++;let sent=false;return {ok:true,status:200,headers:{get:()=> 'application/octet-stream'},body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:new Uint8Array(1048576)}),cancel:async()=>{}})}}}});
  engine.validResponse=r=>assert.ok(r.ok);await h.run();
  assert.equal(trials,2);assert.deepEqual(destinations,['laxspeed.sharktech.net','laxspeed.sharktech.net']);assert.ok(h.get('.card').classList.contains('done-glow'));
});
test('no healthy automatic server stops before measurement and never reports success',async()=>{
  const engine=goodEngine();let downloads=0;engine.ping=async()=>{throw Error('server unavailable')};engine.download=async()=>downloads++;
  const h=harness(engine,{auto:true});await h.run();assert.equal(downloads,0);assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.match(h.get('statusMsg').innerHTML,/unavailable/);
});
