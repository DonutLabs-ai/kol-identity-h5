# Donut cluster deployment

The standalone Node.js worker generates one main image with Cory's existing Gemini
fast prompt, then uses a resident Python `isnet-general-use` CPU session to cut out
that same image. Pillow creates the existing blur plate. `CARD_CUTOUT_PROVIDER`
defaults to `isnet`; `bedrock` is an explicit operator selection, with no automatic
fallback or repeat paid generation. Activity sessions, business quotas, ownership,
retention and frontend integration remain in donut-backend.

The ARM64 image runs as UID 1000. It contains the pinned model
SHA-256 `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a`,
rembg 2.0.69, ONNX Runtime 1.31.0 and a Numba import cache prepared during build.
`NUMBA_CPU_NAME=generic` is set at build and runtime: QEMU's detected CPU features
and Graviton's `neoverse-n1` differ, which caused cache misses and a measured
51.52-second native first readiness. A portable compilation target addresses that
cache identity mismatch ([Numba documentation](https://numba.readthedocs.io/en/stable/reference/envvars.html#numba-cpu-name)).
Startup verifies the model before declaring readiness. The model session is loaded
once, and every local cutout uses a serial queue. Concurrent whole pipelines do not
spawn more segmenters. No model is downloaded at runtime. Numba cache usability
and first readiness still require verification on a fresh native ARM64 Pod.

Build context is `tools/cardgen`. Run `npm ci --ignore-scripts --no-audit --no-fund`,
`npm test`, and `docker buildx build --platform linux/arm64 --build-arg
CARD_SOURCE_REVISION=<verified-source-identity>`. Pin the resulting digest in
`k8s-applications/donut-cardgen`; the corresponding Argo Application remains under
normal repository review. Source preparation and temporary QA do not establish
that the permanent service is deployed.

Keep one Recreate replica and a 50 GiB RWO cache at `/app/out/server-cache`. The
scheduler and journal are single-writer; HPA requires a separately reviewed shared
queue/store contract. IS-Net runs in the Sydney worker and needs no Bedrock role,
US region or per-request Bedrock quota. Kubernetes token automount is disabled.

The internal service is ClusterIP. Require `CARD_REQUIRE_AUTH=true` and a private
`CARD_AUTH_TOKEN`. Every submission, polling, asset and OPTIONS request requires
the service bearer; only GET `/healthz` is public. External Secrets selects the
company `test/donut-backend-secrets.OPENROUTER_API_KEY` and the dedicated
`test/donut-cardgen-secrets.CARD_AUTH_TOKEN`. Never expose these in browser code.

| Variable | Default | Purpose |
| --- | --- | --- |
| CARD_CUTOUT_PROVIDER | isnet | Explicit cutout engine |
| CARD_ISNET_MODEL_PATH | /opt/cardgen-models/isnet-general-use.onnx | Baked, checksummed model |
| CARD_ISNET_THREADS | 2 | ONNX CPU threads; one inference at a time |
| CARD_ISNET_TIMEOUT_MS | 60000 | Kill a stalled segmenter and fail current/queued cutouts |
| CARD_ISNET_STARTUP_TIMEOUT_MS | 120000 | Bound model initialization before HTTP readiness |
| CARD_MAX_ACTIVE_JOBS | 4 | Bound full render pipelines |
| CARD_MAX_QUEUED_JOBS | 1000 | Bound queued admission; overflow 429 |
| CARD_MAX_RETAINED_JOBS | 20000 | Bound retained identities; overflow 503 |
| CARD_MIN_FREE_DISK_BYTES | 5368709120 | Preserve 5 GiB plus outstanding output reservation |
| CARD_MAX_HTTP_REQUESTS | 64 | Bound concurrent protected HTTP handlers |
| CARD_MAX_REQUEST_BYTES | 8388608 | JSON input bound |
| CARD_MAX_AVATAR_BYTES | 5242880 | Decoded avatar bound |

`CARD_BUDGET` is absent/blank for unlimited advisory Gemini spend, or a finite
nonnegative USD amount. Zero starts no paid call. This process-local check resets
on restart; persistent product attempt quotas and cancellation counting belong
to donut-backend. Technical queue bounds do not impose a business generation quota.

Durable admission precedes dispatch. Duplicates share one job. Queued work and
terminal results survive restart; interrupted running work fails with
`provider_result_unknown` rather than repeating an uncertain paid request.
Completed Bedrock identities remain readable after selecting IS-Net. Queued records
for a different cutout model fail explicitly before a new Gemini call; there is
no implicit migration or cache identity reset. Corrupt state fails startup.

A segmenter crash or inference timeout fails its pending operation, stops its
resident process and makes health return 503. New submissions then return
`segmenter_unavailable`; queued render work cannot begin a new paid call. The
worker does not silently respawn the model or call another provider. SIGTERM stops
admission, drains started pipelines and closes the resident process. Termination
grace remains 1200s; provider latency still prevents a universal drain guarantee.

Only `done` exposes all three authenticated asset URLs. Main validation, RGBA
alpha/dimension validation and a usable JPEG plate are required; no 15-second
main-only success path exists in `worker.mjs`. Reserve at least 80 MiB per pending
job before writing its avatar and retain known identities under disk/history
pressure. A 50 GiB volume can refuse admissions before 1000 queued jobs. There is
no automatic history eviction; this cache is not six-month object storage.

`GET /healthz` reports source identity, actual cutout provider/model, IS-Net thread
count, auth, advisory budget and queue occupancy, without credentials. The optional
Bedrock path still uses US-West2 with Sydney STS, persisted pacing at 3100ms after
each SDK outcome, and no SDK retry. Its quota remains separate from local CPU
throughput. Support case 179155317600800 asks about manual quota eligibility;
submission does not establish approval.

Native load testing uses an existing approved 1024x1024 portrait as the main image,
with real IS-Net, PNG validation, writes and Pillow plate work, but no paid image
provider call. Report cold readiness separately from steady-state cutout latency,
burst completion/queue wait, health latency, cgroup CPU/memory and OOM. One repeated
portrait cannot prove segmentation quality across styles or full campaign traffic.
The prior mocked admission tests do not establish actual inference throughput.

The existing blurred plate can retain the subject silhouette. Clean-background
visual acceptance, real Connect X/wallet flow, refresh recovery, public reveal,
PNG save/share and expiry remain separate product acceptance work.

## Native CPU load, 2026-10-09

85/85 jobs completed in bursts of 10, 25 and 50 on a native ARM64
`c6g.xlarge` Pod limited to 2 vCPU and 4 GiB. One resident IS-Net session used
two ONNX threads; four whole pipelines overlapped validation/plate work.
The main image provider was an existing portrait fixture: no paid Gemini call,
no live OpenRouter throughput or end-to-end generation latency is asserted.

| Burst | Last completion | Burst completions/minute |
| --- | --- | --- |
| 10 | 68.13 s | 8.81 |
| 25 | 169.52 s | 8.85 |
| 50 | 339.38 s | 8.84 |

Local cutout P50 was 6.71 s, P95 6.80 s, max 6.90 s. Loopback health P95
was 1.33 ms over 1152 samples. Peak cgroup memory was 2,434,854,912 bytes
(2.27 GiB), with zero OOM/OOM kills. All 255 output files decoded as 1024x1024:
main RGB PNG, foreground RGBA PNG, plate RGB JPEG.

Each burst drained before the next; these are burst averages, not a continuous
arrival or long-duration stability result. Replica scaling was not tested.
This load used frozen source overlay
`bb6f184df58026e7c7d36cf3218c5e97932b29f484147fce900fb60e308eae32` on runtime
image `sha256:9a00c0fe53017ec754766d3a77d80f461e1dae17c1b9895ca4dc5f1db3b17c66`,
Pod UID `2e763ce6-cb12-4906-88be-e4f094120568`. Subsequent IPC/paid-dispatch guards
were regression tested separately; final packaged-image verification must bind
the actual source commit and image digest. The old base with an empty Numba cache
took 51.21 s to become ready; this is not the final image's cold-start result.

Raw report, file hashes, runtime identity and sample layers are retained under
`/home/amlo/Artifacts/donut-trader-20261009/cardgen-isnet/`. Reproduce with
`CARD_BENCH_IMAGE=<approved-1024-png> CARD_BENCH_OUTPUT=<new-empty-dir>
node isnet-load-test.mjs`. This repeats one portrait; broad visual quality,
real Gemini behavior and the complete frontend flow need separate acceptance.
