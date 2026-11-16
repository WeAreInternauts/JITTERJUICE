const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Clock {
  constructor() { this.time=0; this.next=0; this.tasks=new Map(); }
  set(fn,ms,repeat=0) { const id=++this.next; this.tasks.set(id,{fn,at:this.time+ms,repeat}); return id; }
  clear(id) { this.tasks.delete(id); }
  async flush() { for(let i=0;i<30;i++) await Promise.resolve(); }
  async settle(promise,limit=30000) {
    let done=false,result,error; promise.then(v=>{result=v;done=true},e=>{error=e;done=true});
    await this.flush();
    for(let turns=0;!done&&turns<20000;turns++) {
      const entry=[...this.tasks.entries()].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      assert.ok(entry,'pending promise without scheduled work'); const [id,task]=entry;
      assert.ok(task.at<=limit,'test exceeded virtual time limit'); this.time=task.at;
      task.repeat ? task.at+=task.repeat : this.tasks.delete(id); task.fn(); await this.flush();
    }
    assert.ok(done,'promise did not settle'); if(error) throw error; return result;
  }
}
function setup(fetchImpl, XHR) {
  const clock=new Clock();
  const context={performance:{now:()=>clock.time}, AbortController, DOMException, Uint8Array, console,
    crypto:{getRandomValues:a=>a.fill(42)},
    setTimeout:(fn,ms)=>clock.set(fn,ms),clearTimeout:id=>clock.clear(id),
    setInterval:(fn,ms)=>clock.set(fn,ms,ms),clearInterval:id=>clock.clear(id),
    fetch:(...args)=>fetchImpl(clock,...args),XMLHttpRequest:XHR&&XHR(clock),module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../measurement-engine.js'),'utf8'),context);
  return {engine:context.module.exports,clock};
}
const response=(status=200,type='application/octet-stream',body=null)=>({ok:status>=200&&status<300,status,headers:{get:()=>type},body});
function streaming(clock,_url,{signal}) {
  return Promise.resolve(response(200,'application/octet-stream',{getReader:()=>({
    read:()=>new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new DOMException('abort','AbortError'));
      const id=clock.set(()=>{signal.removeEventListener('abort',abort);resolve({done:false,value:new Uint8Array(clock.time<1200?1000:5000)});},100);
      const abort=()=>{clock.clear(id);reject(new DOMException('abort','AbortError'));}; signal.addEventListener('abort',abort,{once:true});
    }),cancel:async()=>{}
  })}));
}
function xhrClass(clock, outcome='success', delay=150) {
  return class {
    constructor(){this.upload={};this.status=0;this.ended=false;}
    open(){}
    send(payload){this.payload=payload;clock.set(()=>this.upload.onprogress?.({loaded:payload.byteLength}),20);this.id=clock.set(()=>{if(this.ended)return;this.ended=true;if(outcome==='timeout')this.ontimeout?.();else{this.status=outcome==='failure'?500:204;this.onload?.();}},delay);}
    abort(){if(this.ended)return;this.ended=true;clock.clear(this.id);this.onabort?.();}
  };
}

test('rejects HTTP errors and HTML/JSON rather than counting error pages',()=>{
  const {engine}=setup(()=>{});
  for(const r of [response(500),response(200,'text/html'),response(200,'application/json')])assert.throws(()=>engine.validResponse(r));
  engine.validResponse(response());
});
test('download uses total post-warmup bytes / elapsed time, including slower intervals',async()=>{
  const {engine,clock}=setup(streaming);let baseline;
  const result=await clock.settle(engine.download({url:()=>'/data',signal:new AbortController().signal,durationMs:2600,warmupMs:400,streams:1,onProgress:p=>{if(!p.warming&&baseline===undefined)baseline=p.bytes;}}));
  assert.equal(result.mbps,(result.bytes-baseline)*8/result.measuredMs/1000);
  assert.ok(result.mbps<0.4,'must include slower measurement intervals, not only highest samples');
  assert.equal(clock.tasks.size,0,'cleans phase timers');
});
test('download rejects HTTP 500 and empty body',async()=>{
  for(const empty of [false,true]){
    const {engine,clock}=setup(async()=>empty?response(200,'application/octet-stream',{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{}})}):response(500));
    await assert.rejects(clock.settle(engine.download({url:()=>'/data',signal:new AbortController().signal,streams:1})),/failed/);
    assert.equal(clock.tasks.size,0);
  }
});
test('download cancellation rejects instead of producing success',async()=>{
  const {engine,clock}=setup(streaming);const ctrl=new AbortController();clock.set(()=>ctrl.abort(),800);
  await assert.rejects(clock.settle(engine.download({url:()=>'/data',signal:ctrl.signal,streams:1})),{name:'AbortError'});
  assert.equal(clock.tasks.size,0);
});
test('download hanging headers time out and do not manufacture a zero result',async()=>{
  const {engine,clock}=setup((_clock,_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError')),{once:true})));
  await assert.rejects(clock.settle(engine.download({url:()=>'/data',signal:new AbortController().signal,durationMs:1500,streams:1})),/Insufficient/);
  assert.equal(clock.time,1500);assert.equal(clock.tasks.size,0);
});
test('upload progress does not count as HTTP acknowledgement',async()=>{
  const {engine,clock}=setup(()=>{},c=>xhrClass(c,'failure'));let progressed=false;
  await assert.rejects(clock.settle(engine.uploadRequest('/up',new Uint8Array(100),new AbortController().signal,1000,()=>progressed=true)),/HTTP 500/);
  assert.ok(progressed);assert.equal(clock.time,150,'waits for response, not progress');
});
test('upload success resolves only after server 2xx',async()=>{
  const {engine,clock}=setup(()=>{},c=>xhrClass(c));
  assert.equal(await clock.settle(engine.uploadRequest('/up',new Uint8Array(123),new AbortController().signal,1000,()=>{})),123);
  assert.equal(clock.time,150);
});
test('upload timeout and abort reject',async()=>{
  const a=setup(()=>{},c=>xhrClass(c,'timeout'));
  await assert.rejects(a.clock.settle(a.engine.uploadRequest('/up',new Uint8Array(1),new AbortController().signal,1000,()=>{})),/timed out/);
  const b=setup(()=>{},c=>xhrClass(c));const ctrl=new AbortController();b.clock.set(()=>ctrl.abort(),50);
  await assert.rejects(b.clock.settle(b.engine.uploadRequest('/up',new Uint8Array(1),ctrl.signal,1000,()=>{})),{name:'AbortError'});
});
test('upload phase rejects a server failure after progress',async()=>{
  const {engine,clock}=setup(()=>{},c=>xhrClass(c,'failure'));
  await assert.rejects(clock.settle(engine.upload({url:()=>'/up',signal:new AbortController().signal,workers:1})),/failed/);
  assert.equal(clock.tasks.size,0);
});
test('successful upload rate is based on acknowledged post-warmup bytes and elapsed time',async()=>{
  const {engine,clock}=setup(()=>{},c=>xhrClass(c));let baseline;
  const result=await clock.settle(engine.upload({url:()=>'/up',signal:new AbortController().signal,workers:1,durationMs:2600,warmupMs:400,onProgress:p=>{if(!p.warming&&baseline===undefined)baseline=p.bytes;}}));
  assert.equal(result.measuredMs,1200);
  const acknowledgedWarmupBytes=4096+8192+16384; // completed at 150, 300, 450 ms
  assert.equal(result.measuredBytes,result.acknowledgedBytes-acknowledgedWarmupBytes);
  assert.equal(result.mbps,result.measuredBytes*8/1200/1000);
  assert.equal(clock.tasks.size,0);
});
test('download stalled body is interrupted by deadline',async()=>{
  const {engine,clock}=setup(async(_clock,_url,{signal})=>response(200,'application/octet-stream',{getReader:()=>({read:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError')),{once:true})),cancel:async()=>{}})}));
  await assert.rejects(clock.settle(engine.download({url:()=>'/data',signal:new AbortController().signal,durationMs:1500,streams:1})),/Insufficient/);
  assert.equal(clock.time,1500);assert.equal(clock.tasks.size,0);
});
test('data cap reached before adequate measurement is rejected, not presented as a valid speed',async()=>{
  const {engine,clock}=setup(streaming);
  await assert.rejects(clock.settle(engine.download({url:()=>'/data',signal:new AbortController().signal,maxBytes:1000,streams:1})),/Data limit/);
  assert.equal(clock.tasks.size,0);
});
test('warmup completes before measured upload requests and late acknowledgements remain in elapsed span',async()=>{
  const launches=[];let count=0;
  const {engine,clock}=setup(()=>{},c=>class extends xhrClass(c){
    send(payload){launches.push({at:c.time,bytes:payload.byteLength});this.payload=payload;const ordinal=++count;c.set(()=>this.upload.onprogress?.({loaded:payload.byteLength}),20);this.id=c.set(()=>{if(this.ended)return;this.ended=true;this.status=204;this.onload();},ordinal===4?1400:150);}
  });
  const result=await clock.settle(engine.upload({url:()=>'/up',signal:new AbortController().signal,workers:1,durationMs:2600,warmupMs:400}));
  assert.equal(launches[3].at,450,'measurement starts after final warmup ack');
  assert.equal(result.measuredMs,1400,'late final ack included rather than discarded at launch deadline');
  assert.equal(result.measuredBytes,launches[3].bytes);assert.equal(result.mbps,result.measuredBytes*8/1400/1000);
});
test('stalled measured upload acknowledgement rejects the phase instead of returning a partial speed',async()=>{
  let count=0;
  const {engine,clock}=setup(()=>{},c=>class extends xhrClass(c){
    send(payload){if(++count<=3)return super.send(payload);this.payload=payload;c.set(()=>this.upload.onprogress?.({loaded:payload.byteLength}),20);this.id=c.set(()=>{if(this.ended)return;this.ended=true;this.ontimeout();},this.timeout);}
  });
  await assert.rejects(clock.settle(engine.upload({url:()=>'/up',signal:new AbortController().signal,workers:1,durationMs:2600,warmupMs:400})),/did not acknowledge/);
  assert.equal(clock.tasks.size,0);
});
