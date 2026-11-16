# JitterJuice 0.3.0

Device-to-server application throughput test. The live interface preserves the original visual design while replacing the measurement engine.

## Method

- Auto selection runs only after Start. CORS-valid HTTP latency checks rank all test endpoints; up to three bounded 1 MiB download trials choose among the lowest-latency candidates and Cloudflare. The choice is frozen for the entire test.
- Download: six concurrent HTTP requests (not necessarily independent transport connections), 1.5 seconds of warmup after first data, then aggregate delivered payload bytes divided by matching elapsed time. Ten-second phase deadline, 512 MiB payload budget with possible in-flight chunk overshoot.
- Upload: four workers, adaptive 4 KiB–8 MiB payloads. Warmup requests fully finish before measurement. Only successful HTTP 2xx completed measured requests count; the elapsed interval ends at the final acknowledgment. Unconfirmed requests invalidate the phase. Requests have 3-second timeouts and the phase has a hard deadline. Budget 256 MiB including warmup.
- Latency: median HTTP round-trip time after a discarded warmup probe. Variation is mean absolute deviation around the median. This includes browser/server overhead, not ICMP ping.
- Stop or backgrounding cancels the run. Completed valid metrics remain; incomplete metrics are discarded. Partial failures never show the full-success state.

No IP-location lookup or test-server traffic occurs on initial page load. Existing externally hosted fonts still load. Test servers necessarily receive network requests and the connecting IP. No new analytics or result-collection service was added.

## Limits

This is application payload throughput to a specific endpoint, not modem speed, isolated Wi-Fi speed, or guaranteed ISP line capacity. HTTP request and acknowledgment overhead can affect upload comparisons. Data caps can shorten high-speed samples or prevent an adequate sample; these conditions are disclosed. Short server trials cannot guarantee selection of the highest-capacity endpoint. Loaded latency and packet loss are not measured. A full test can transfer about 810 MB plus protocol overhead.

## Validation

Run `node --test tests/*.test.cjs` with Node 22. The suite uses deterministic virtual transfers and a DOM flow harness; it does not require or consume real speed-test traffic. GitHub Actions runs the same suite on pushes and pull requests.

Validated cases include HTTP errors, wrong MIME and empty payloads, stalls, upload acknowledgment versus progress, warmup boundaries, final acknowledgment time, data caps, cancellation, frozen endpoint selection, complete versus partial UI states, and document/script integrity.

This suite does not establish calibration against a physical internet connection. Browser render and live endpoint smoke checks are separate release checks. Compare several alternating runs against other testers on the same device/browser/network before drawing capacity conclusions.
