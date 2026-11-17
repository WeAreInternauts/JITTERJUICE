/* JitterJuice measurement engine. Rates are application payload Mbps, not line rate. */
(function (root) {
  'use strict';
  const now = () => performance.now();
  const abortError = () => new DOMException('Test cancelled', 'AbortError');
  function check(signal) { if (signal && signal.aborted) throw abortError(); }
  function scope(signal, ms) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal) { check(signal); signal.addEventListener('abort', cancel, { once: true }); }
    const timer = setTimeout(cancel, ms);
    return { signal: controller.signal, abort: cancel, close() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancel); } };
  }
  function validResponse(response) {
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(type)) throw new Error('Server returned a page instead of test data');
  }
  async function ping(url, signal, count = 7) {
    const values = [];
    for (let i = 0; i < count + 1; i++) {
      check(signal);
      const request = scope(signal, 2500), start = now();
      try {
        const response = await fetch(url + (url.includes('?') ? '&' : '?') + '_p=' + Math.random(), { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Ping server unavailable');
        await response.arrayBuffer();
        if (i) values.push(now() - start);
      } catch (error) { check(signal); } finally { request.close(); }
    }
    if (values.length < 3) throw new Error('Server did not respond reliably');
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    return { ms: median, jitter: values.reduce((sum, v) => sum + Math.abs(v - median), 0) / values.length };
  }
  async function download(options) {
    const { url, signal, onProgress = () => {}, durationMs = 10000, warmupMs = 1500, maxBytes = 512 * 1024 * 1024, streams = 6 } = options;
    check(signal);
    const phase = scope(signal, durationMs), start = now();
    let bytes = 0, baseline = 0, measuredAt = null, errors = 0, finished = false;
    let firstDataAt = null;
    const sample = () => {
      const time = now();
      if (measuredAt === null && firstDataAt !== null && (time - firstDataAt >= warmupMs || bytes >= maxBytes / 4)) { measuredAt = time; baseline = bytes; }
      const elapsed = measuredAt === null ? 0 : time - measuredAt;
      onProgress({ mbps: elapsed > 0 ? (bytes - baseline) * 8 / elapsed / 1000 : 0, bytes, warming: measuredAt === null });
    };
    const ticker = setInterval(sample, 200);
    async function worker() {
      while (!phase.signal.aborted && bytes < maxBytes) {
        try {
          const response = await fetch(url(16 * 1024 * 1024), { signal: phase.signal, cache: 'no-store' });
          validResponse(response);
          if (!response.body) throw new Error('Streaming response unavailable');
          const reader = response.body.getReader();
          let received = 0;
          try {
            while (!phase.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength) { if (firstDataAt === null) firstDataAt = now(); bytes += value.byteLength; received += value.byteLength; }
              if (bytes >= maxBytes) { finished = true; phase.abort(); break; }
            }
          } finally { try { await reader.cancel(); } catch {} }
          if (!received && !phase.signal.aborted) throw new Error('Empty test response');
        } catch (error) {
          if (phase.signal.aborted) break;
          errors++;
          if (errors >= 3) { phase.abort(); break; }
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: streams }, worker));
      sample();
      check(signal);
      const end = now(), elapsedMs = measuredAt === null ? 0 : end - measuredAt;
      if (errors || elapsedMs < 200 || bytes <= baseline) throw new Error(errors ? 'Download server failed during test' : finished ? 'Data limit reached before a reliable download sample' : 'Insufficient download data');
      return { mbps: (bytes - baseline) * 8 / elapsedMs / 1000, bytes, measuredMs: elapsedMs, elapsedMs: end - start, errors, capped: finished };
    } finally { clearInterval(ticker); phase.abort(); phase.close(); }
  }
  function uploadRequest(url, payload, signal, timeoutMs, progress) {
    return new Promise((resolve, reject) => {
      check(signal);
      const xhr = new XMLHttpRequest();
      let settled = false;
      const abort = () => xhr.abort();
      const finish = (error) => {
        if (settled) return; settled = true;
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(payload.byteLength);
      };
      xhr.open('POST', url, true); xhr.timeout = timeoutMs;
      // No upload event listener: it forces a CORS preflight on cross-origin XHR.
      // Count payload only after the endpoint acknowledges the POST.
      if (xhr.setRequestHeader) xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { progress(payload.byteLength); finish(null); }
        else finish(new Error(`Upload returned HTTP ${xhr.status}`));
      };
      xhr.onerror = () => finish(new Error('Upload server unavailable'));
      xhr.ontimeout = () => finish(new Error('Upload timed out'));
      xhr.onabort = () => finish(abortError());
      signal.addEventListener('abort', abort, { once: true });
      xhr.send(payload);
    });
  }
  async function upload(options) {
    const { url, signal, onProgress = () => {}, durationMs = 10000, warmupMs = 1500, maxBytes = 256 * 1024 * 1024, workers = 4 } = options;
    check(signal);
    // Generate before starting the clock. Warmup requests fully settle before measured requests begin.
    const payload = new Uint8Array(8 * 1024 * 1024);
    for (let offset = 0; offset < payload.length; offset += 65536) crypto.getRandomValues(payload.subarray(offset, offset + 65536));
    const phase = scope(signal, durationMs + 8500), start = now();
    let bytes = 0, wireBytes = 0, reserved = 0, errors = 0;
    let measuredAt = null, measuredBytes = 0, finishedAt = null, deadlineHit = false;
    const ticker = setInterval(() => {
      const elapsed = measuredAt === null ? 0 : now() - measuredAt;
      onProgress({ mbps: elapsed > 0 ? measuredBytes * 8 / elapsed / 1000 : 0, bytes: wireBytes, warming: measuredAt === null });
    }, 200);
    const workerSizes = Array(workers).fill(4 * 1024);
    async function stage(isWarmup) {
      const stageStart = now();
      const launchMs = isWarmup ? warmupMs : Math.max(1000, durationMs - warmupMs - 1000);
      const initialReserved = reserved;
      async function worker(workerId) {
        let size = workerSizes[workerId]; // Preserve this worker's learned warmup size.
        while (!phase.signal.aborted && now() - stageStart < launchMs && reserved < maxBytes) {
          if (isWarmup && reserved - initialReserved >= maxBytes / 8) break;
          const chunkSize = Math.min(size, maxBytes - reserved);
          reserved += chunkSize;
          let previous = 0;
          const requestStart = now();
          try {
            await uploadRequest(url(), payload.subarray(0, chunkSize), phase.signal, 8000, loaded => { wireBytes += Math.max(0, loaded - previous); previous = loaded; });
            bytes += chunkSize;
            if (!isWarmup) { measuredBytes += chunkSize; finishedAt = now(); }
            const requestMs = now() - requestStart;
            const factor = Math.max(0.5, Math.min(2, 400 / Math.max(1, requestMs)));
            size = Math.max(4 * 1024, Math.min(8 * 1024 * 1024, Math.floor(chunkSize * factor)));
            workerSizes[workerId] = size;
          } catch (error) {
            if (phase.signal.aborted) { deadlineHit = true; break; }
            errors++; break;
          }
        }
      }
      await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)));
    }
    try {
      await stage(true); check(signal);
      if (errors || deadlineHit) throw new Error('Upload warmup failed or timed out');
      measuredAt = now();
      await stage(false); check(signal);
      const elapsedMs = finishedAt === null ? 0 : finishedAt - measuredAt;
      const capped = reserved >= maxBytes;
      if (errors || deadlineHit || elapsedMs < 200 || !measuredBytes) throw new Error(errors || deadlineHit ? 'Upload server failed or did not acknowledge every request' : capped ? 'Data limit reached before a reliable upload sample' : 'Insufficient acknowledged upload data');
      return { mbps: measuredBytes * 8 / elapsedMs / 1000, bytes: wireBytes, acknowledgedBytes: bytes, measuredBytes, measuredMs: elapsedMs, elapsedMs: now() - start, errors, capped };
    } finally { clearInterval(ticker); phase.abort(); phase.close(); }
  }
  const api = { ping, download, upload, uploadRequest, validResponse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JJMeasurement = api;
})(typeof window !== 'undefined' ? window : globalThis);
