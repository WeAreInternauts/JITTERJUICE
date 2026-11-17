# JitterJuice 0.3.1

Device-to-server application throughput test. The live interface preserves the original visual design while replacing the measurement engine.

## Method

- Every Start automatically rechecks test servers, ignoring previously stored manual choices. Candidates must pass latency, download, and acknowledged upload checks. Sequential, bounded 4 MiB download trials rank a shortlist of three healthy low-latency candidates, including Cloudflare when healthy; the choice is frozen during each full measurement attempt. A failed attempt triggers one automatic fallback to the next healthy server. Results from different servers are not combined.
- Download: six concurrent HTTP requests (not necessarily independent transport connections), 1.5 seconds of warmup after first data, then aggregate delivered payload bytes divided by matching elapsed time. Ten-second phase deadline, 512 MiB payload budget with possible in-flight chunk overshoot.
- Upload: four workers, adaptive 4 KiB–8 MiB payloads. Warmup requests fully finish before measurement. Only successful HTTP 2xx completed measured requests count; the elapsed interval ends at the final acknowledgment. Unconfirmed requests invalidate the phase. Each worker adapts its own payload size to avoid shared growth overshoot. Requests have bounded timeouts and the phase has a hard deadline. Upload progress listeners are omitted; only completed server acknowledgments count. Budget 256 MiB including warmup.
- Latency: median HTTP round-trip time after a discarded warmup probe. Variation is mean absolute deviation around the median. This includes browser/server overhead, not ICMP ping.
- There is no Stop control. Backgrounding cancels the run. Failed attempts are automatically retried on a healthy alternate, with a maximum of two full attempts and an overall 75-second deadline. Incomplete results never show the full-success state. Terminal messages do not ask users to choose a server.

No IP-location lookup or test-server traffic occurs on initial page load. Existing externally hosted fonts still load. Test servers necessarily receive network requests and the connecting IP. No new analytics or result-collection service was added.

## Limits

This is application payload throughput to a specific endpoint, not modem speed, isolated Wi-Fi speed, or guaranteed ISP line capacity. HTTP request and acknowledgment overhead can affect upload comparisons. Data caps can shorten high-speed samples or prevent an adequate sample; these conditions are disclosed. Short server trials cannot guarantee selection of the highest-capacity endpoint. Loaded latency and packet loss are not measured. Including automatic fallback, a test can transfer about 1.7 GB plus protocol overhead. The normal single-attempt budget remains about 810 MB; screening traffic and in-flight chunks add a small amount.

## Validation

Run `node --test tests/*.test.cjs` with Node 22. The suite uses deterministic virtual transfers and a DOM flow harness; it does not require or consume real speed-test traffic. GitHub Actions runs the same suite on pushes and pull requests.

Validated cases include HTTP errors, wrong MIME and empty payloads, stalls, upload acknowledgment versus progress, warmup boundaries, final acknowledgment time, data caps, cancellation, frozen endpoint selection, complete versus partial UI states, and document/script integrity.

This suite does not establish calibration against a physical internet connection. Browser render and live endpoint smoke checks are separate release checks. Compare several alternating runs against other testers on the same device/browser/network before drawing capacity conclusions.
