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
  const listeners={},requests=[],timers=new Map();let nextTimer=0;
  const document={getElementById:get,querySelector:s=>get(s),querySelectorAll:()=>[],createElement:()=>element('new'),createElementNS:()=>element('svg'),addEventListener(name,fn){listeners[name]=fn},activeElement:null,hidden:false};
  const context={document,console,AbortController,DOMException,Uint8Array,performance:{now:()=>time},
    crypto:{getRandomValues:a=>a.fill(42)},localStorage:{getItem:k=>k==='jj:autoMode'?'false':(k==='jj:serverId'?(options.persistedServer||'shark-ams'):null),setItem(){}},
    fetch:async(...args)=>{requests.push(args);time+=options.fetchMs?options.fetchMs(args[0]):(args[0].includes('cloudflare')?100:200);if(options.fetch)return options.fetch(...args);let sent=false;return {ok:true,status:200,headers:{get:()=> 'application/octet-stream'},body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:new Uint8Array(1048576)}),cancel:async()=>{}})}}},
    setTimeout:(fn,ms)=>{timers.set(++nextTimer,{fn,ms});return nextTimer},clearTimeout:id=>timers.delete(id),setInterval:()=>1,clearInterval(){},
    requestAnimationFrame:fn=>{time+=1000;queueMicrotask(()=>fn(time));return 1},
    matchMedia:()=>({matches:true}),innerWidth:1000,innerHeight:800,devicePixelRatio:1,
    addEventListener(){},JJMeasurement:engine,__JJ_TEST__:true};
  context.window=context; context.globalThis=context;
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  let script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('async function runTest'));
  vm.runInNewContext(script,context);
  return {context,get,requests,document,listeners,timers,run:()=>context.JJTestHooks.runTest()};
}
// Added integration assertions below after engine wiring settles.
module.exports={harness};
test('document preserves complete markup, engine inclusion and parseable inline script',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  for(const pattern of [/<\/style>/,/<body\b/,/<\/body>/,/<main\b/,/<\/main>/,/<script[^>]+src=["'](?:\.\/)?measurement-engine\.js["']/,/id="btnStart"/,/id="statusMsg"/]) assert.ok(pattern.test(html),`missing document structure ${pattern}`);
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});
function goodEngine(){return {ping:async()=>({ms:12,jitter:2}),validResponse:r=>assert.ok(r.ok),uploadRequest:async(_url,payload)=>payload.byteLength,download:async()=>({mbps:80,bytes:100000,measuredMs:10000,elapsedMs:11500}),upload:async()=>({mbps:20,bytes:25000,acknowledgedBytes:25000,measuredMs:10000,elapsedMs:11500})};}
test('document removes Stop and manual server controls',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.equal(/id="btnStop"/.test(html),false);assert.equal(/id="btnChangeServer"/.test(html),false);
});
test('successful complete run shows all metrics and restores Start',async()=>{
  const h=harness(goodEngine());await h.run();
  assert.equal(h.get('dlVal').textContent,'80');assert.equal(h.get('ulVal').textContent,'20');
  assert.ok(h.get('.card').classList.contains('done-glow'));assert.match(h.get('statusMsg').innerHTML,/complete/);
  assert.equal(h.get('btnStart').disabled,false);
});
test('page initialization performs no external measurements',()=>{
  const h=harness(goodEngine());assert.equal(h.requests.length,0);
});
test('automatic selection ignores persisted manual server and chooses healthy trial winner',async()=>{
  const engine=goodEngine(),destinations=[];const healthUploads=[];
  engine.uploadRequest=async(url,payload)=>{healthUploads.push(new URL(url).hostname);return payload.byteLength};
  engine.download=async o=>{destinations.push(new URL(o.url(100)).hostname);return {mbps:80,bytes:100,measuredMs:1000}};
  engine.upload=async o=>{destinations.push(new URL(o.url()).hostname);return {mbps:20,bytes:100,measuredMs:1000}};
  const h=harness(engine,{persistedServer:'shark-ams'});await h.run();
  assert.ok(healthUploads.length>=2,'checks actual upload capability before choosing');
  assert.deepEqual(destinations,['speed.cloudflare.com','speed.cloudflare.com']);assert.ok(h.get('.card').classList.contains('done-glow'));
});
test('server with broken upload health check is excluded before full measurement',async()=>{
  const engine=goodEngine(),destinations=[];let checkedBroken=false;
  engine.uploadRequest=async(url,payload)=>{if(url.includes('cloudflare')){checkedBroken=true;throw Error('Upload returned HTTP 500')}return payload.byteLength};
  engine.download=async o=>{destinations.push(new URL(o.url(1)).hostname);return {mbps:80,bytes:100,measuredMs:1000}};
  engine.upload=async o=>{destinations.push(new URL(o.url()).hostname);return {mbps:20,bytes:100,measuredMs:1000}};
  const h=harness(engine);await h.run();assert.ok(checkedBroken);assert.equal(destinations.length,2);assert.ok(destinations.every(x=>!x.includes('cloudflare')));assert.equal(destinations[0],destinations[1]);assert.ok(h.get('.card').classList.contains('done-glow'));
});
test('upload phase failure restarts latency download and upload on same fallback endpoint',async()=>{
  const engine=goodEngine(),phases=[];
  engine.ping=async url=>{phases.push(['ping',new URL(url).hostname]);return {ms:12,jitter:2}};
  engine.download=async o=>{const host=new URL(o.url(1)).hostname;phases.push(['download',host]);return {mbps:host.includes('cloudflare')?80:40,bytes:100,measuredMs:1000}};
  engine.upload=async o=>{const host=new URL(o.url()).hostname;phases.push(['upload',host]);if(host.includes('cloudflare'))throw Error('Upload returned HTTP 500');return {mbps:10,bytes:100,measuredMs:1000}};
  const h=harness(engine);await h.run();const first=phases.findIndex(x=>x[0]==='download');const run=phases.slice(first);
  assert.deepEqual(run.map(x=>x[0]),['download','upload','ping','download','upload']);
  assert.equal(run[2][1],run[3][1]);assert.equal(run[3][1],run[4][1]);assert.notEqual(run[0][1],run[3][1]);
  assert.equal(h.get('dlVal').textContent,'40','discard failed endpoint download instead of mixing');assert.equal(h.get('ulVal').textContent,'10');assert.ok(h.get('.card').classList.contains('done-glow'));
});
test('all upload health checks fail honestly without manual-server instructions',async()=>{
  const engine=goodEngine();let downloads=0;engine.uploadRequest=async()=>{throw Error('Upload unavailable')};engine.download=async()=>downloads++;
  const h=harness(engine);await h.run();assert.equal(downloads,0);assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.match(h.get('statusMsg').innerHTML,/unavailable|could not|unable|No reliable/i);assert.doesNotMatch(h.get('statusMsg').innerHTML,/try another server/i);assert.equal(h.get('btnStart').disabled,false);
});
test('hidden page aborts locked transfer without retry or success',async()=>{
  const engine=goodEngine();let firstUrl,secondUrl,ctrlSignal,release,downloads=0;
  engine.download=async options=>{downloads++;firstUrl=options.url(123);ctrlSignal=options.signal;await new Promise(r=>release=r);secondUrl=options.url(123);if(options.signal.aborted)throw new DOMException('Stopped','AbortError');return {mbps:80,bytes:1,measuredMs:1000}};
  const h=harness(engine);const pending=h.run();for(let i=0;i<150;i++)await Promise.resolve();
  assert.ok(release,'download reached');const state=h.context.JJTestHooks.getState();
  state.activeServer.type='librespeed';state.activeServer.base='https://changed.example';assert.ok(Object.isFrozen(state.testServer));
  h.document.hidden=true;h.listeners.visibilitychange();assert.equal(ctrlSignal.aborted,true);release();await pending;
  assert.equal(new URL(firstUrl).hostname,new URL(secondUrl).hostname);assert.equal(downloads,1);assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.equal(h.get('btnStart').disabled,false);
});
test('all measured upload failures stop bounded retries and never mix or claim success',async()=>{
  const engine=goodEngine(),attempts=[];
  engine.download=async o=>{attempts.push(new URL(o.url(1)).hostname);return {mbps:80,bytes:100,measuredMs:1000}};
  engine.upload=async()=>{throw Error('Upload timed out')};
  const h=harness(engine);await h.run();
  assert.ok(attempts.length>=2,'must attempt fallback');assert.ok(attempts.length<=6,'retry bounded by configured server set');assert.equal(new Set(attempts).size,attempts.length,'no retry loop on known failed endpoint');
  assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.doesNotMatch(h.get('statusMsg').innerHTML,/try another server|^Test complete/i);assert.equal(h.get('btnStart').disabled,false);
});
test('overall deadline cancels stalled transfer and restores Start without retry',async()=>{
  const engine=goodEngine();let release,signal,attempts=0;
  engine.download=async options=>{attempts++;signal=options.signal;await new Promise(r=>release=r);if(signal.aborted)throw new DOMException('timeout','AbortError');};
  const h=harness(engine);const pending=h.run();for(let i=0;i<200;i++)await Promise.resolve();
  assert.ok(release);const deadline=[...h.timers.values()].find(t=>t.ms===75000);assert.ok(deadline,'overall deadline is75seconds');deadline.fn();assert.equal(signal.aborted,true);release();await pending;
  assert.equal(attempts,1);assert.equal(h.get('.card').classList.contains('done-glow'),false);assert.equal(h.get('btnStart').disabled,false);assert.equal(h.timers.size,0);
});
