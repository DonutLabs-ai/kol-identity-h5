# Donut cluster deployment

The deployed `worker.mjs` is a standalone Node.js image worker. It calls the existing
Gemini image model through OpenRouter, derives the foreground from that same image
using AWS Bedrock, and runs Pillow in a separate Python process to create Cory's
existing blur plate. There is no ONNX/IS-Net model in the deployed image. The legacy
`server.mjs` remains an offline demo. Activity sessions, immutable submission
snapshots, paid-attempt accounting, quotas and result permissions belong to the
Donut backend; browsers must use that backend rather than this internal worker.

Build on Linux ARM64 for the current Donut nodes:

```sh
cd tools/cardgen
npm ci --ignore-scripts --no-audit --no-fund
npm test
docker buildx build --platform linux/arm64 \
  --build-arg CARD_SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t <registry>/donut-cardgen:<source-sha> .
```

The image runs as `node` (UID 1000). Mount `/app/out/server-cache` on persistent
storage: this holds small durable job records, avatar inputs, generated assets and
the provider dispatch timestamp. Keep exactly one Recreate replica. A shared rate
limiter and job store would be required before enabling horizontal replicas.

Donut Testing configuration lives in `DonutLabs-ai/k8s-applications/donut-cardgen`;
its Argo Application lives in
`DonutLabs-ai/k8s-infrastructure/default/argocd/test/donut-cardgen-testing.yaml`.
Pin the built image digest in Git and follow normal review/merge policy. Do not
override an Argo-managed Deployment directly. No Production configuration is added.

The worker stays in Sydney. Its IRSA role grants only invocation of the US Remove
Background inference profile and its three US destination models. Configure
`CARD_BEDROCK_REGION=us-west-2` independently of the workload's AWS region and
`CARD_BEDROCK_MODEL=us.stability.stable-image-remove-background-v1:0`. Do not mount
developer AWS credentials or static AWS keys. Provision the reviewed
`k8s-infrastructure/common/CardgenBedrockIam` role before the application sync.

Configure `CARD_REQUIRE_AUTH=true` and a private `CARD_AUTH_TOKEN`. Missing token
then fails startup. Every generation, polling, asset and OPTIONS request requires
the service bearer token; only `GET /healthz` is unauthenticated. A configured token
is enforced even without the require flag. Existing local/demo use can omit both.
Never expose this token in browser code. Donut resolves it through External Secrets
from AWS `test/donut-cardgen-secrets`; the provider key is separately selected from
company AWS `test/donut-backend-secrets.OPENROUTER_API_KEY`. No personal key is used.

`CARD_BUDGET` is an optional finite nonnegative USD limit for the Gemini calls; absent/blank is unlimited,
and zero admits no new paid call. It is an advisory process-local budget, resets on
restart and does not reserve concurrent spend. Persistent product quotas and
idempotency remain the Donut backend's responsibility.

Operational limits are separate from the backend's optional business quota:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CARD_MAX_ACTIVE_JOBS` | 4 | Bound complete render pipelines |
| `CARD_MAX_QUEUED_JOBS` | 1000 | Bound waiting jobs; new overflow returns 429 |
| `CARD_MAX_HTTP_REQUESTS` | 64 | Bound simultaneous protected HTTP handlers; overflow returns 503 |
| `CARD_MAX_REQUEST_BYTES` | 8388608 | Bound JSON request size |
| `CARD_MAX_AVATAR_BYTES` | 5242880 | Bound decoded/downloaded avatar size |
| `CARD_BEDROCK_MIN_INTERVAL_MS` | 3100 | Space paid Bedrock starts, including after restart |
| `CARD_BEDROCK_TIMEOUT_MS` | 90000 | Deadline with unknown outcome; no automatic paid retry |

The applied US-West-2 account quota was 20 Remove Background requests/minute when
verified on 2026-10-09, marked non-adjustable. Do not lower the interval without an
approved and read-back quota allocation. Other account consumers reduce available
capacity. With every main image already ready and no competing traffic, 1000
distinct jobs take roughly 52 minutes just to dispatch at this pace; this is not
a completion guarantee. Four complete pipelines may have lower throughput because
they also wait for Gemini. A Go rewrite does not change those provider limits.

Durable admission precedes dispatch. Same-key concurrent requests share one job;
duplicates remain queryable when the queue is full. Queued jobs resume after a
restart; terminal jobs remain queryable. Interrupted running jobs become failed
with `provider_result_unknown`, because repeating an uncertain paid call may
double-charge. Corrupt state fails startup. There are no provider retries.

POST returns `job_id`, `status` (`queued`, `running`, `done`, `failed`), `stage`, and
`prompt_version`. Poll GET `/v1/identity/card-art/<job_id>` with the same bearer.
Only `done` includes all three asset URLs. There is no main-only 15-second success
fallback in `worker.mjs`. Failures are explicit, and a repeated identical request
reads its existing terminal result without another paid attempt. This worker's
cache identity is not the backend's user request/idempotency identity. The backend
must associate and authorize worker jobs and copy approved assets to its managed
storage before exposing results. The offline demo's six-minute polling deadline
is insufficient for a large queued burst; its UI is not the deployed product adapter.

The blur plate can retain a visible subject silhouette. Alpha/dimension validation
does not prove a clean background or product visual acceptance. The clean-plate
requirement, failure/timeout UX, six-month retention, public result expiry and the
complete frontend/backend integration remain separate acceptance work. Cache disk
capacity must be monitored; there is no automatic eviction of retained job records
or outputs, and a PVC is not an indefinite output archive.

`GET /healthz` includes `source_revision`, `auth_required`, `budget_limit_usd`,
the cutout provider/model/region and queue occupancy. `spent_usd` reports process-local
Gemini usage only; it does not include AWS charges or establish a hard campaign budget.
Health does not expose credentials. Verify these along with every serving Pod digest,
unauthorized 401 and three real output files after deployment.
