# Donut cluster deployment

This standalone JavaScript service calls OpenRouter and uses Python / ONNX for
segmentation. Source, prompts and the design frontend remain in this repository;
the main Donut backend will own activity authentication, immutable submission
snapshots, durable jobs, quotas and result permissions. This service is an internal
image worker, not a replacement for that product backend.

Build on Linux ARM64 for the current Donut nodes:

```sh
node --test tools/cardgen/server-config.test.mjs tools/cardgen/serial-task-queue.test.mjs
docker buildx build --platform linux/arm64 \
  --build-arg CARD_SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t <registry>/donut-cardgen:<source-sha> tools/cardgen
```

The image bakes the segmentation model at `/opt/cardgen-models`, runs as user
`node` (UID 1000) and writes only generated cache under `/app/out/server-cache`.
Mount that cache on persistent storage if outputs must survive replacement.

Donut Testing configuration lives in `DonutLabs-ai/k8s-applications/donut-cardgen`;
its Argo Application lives in
`DonutLabs-ai/k8s-infrastructure/default/argocd/test/donut-cardgen-testing.yaml`.
Pin the built image digest in Git and follow normal review/merge policy. Do not
override an Argo-managed Deployment directly. No Production configuration is added.

Configure `CARD_REQUIRE_AUTH=true` and a private `CARD_AUTH_TOKEN`. Missing token
then fails startup. Every generation, polling, asset and OPTIONS request requires
the service bearer token; only `GET /healthz` is unauthenticated. A configured token
is enforced even without the require flag. Existing local/demo use can omit both.
Never expose this token in browser code. Donut resolves it through External Secrets
from AWS `test/donut-cardgen-secrets`; the provider key is separately selected from
company AWS `test/donut-backend-secrets.OPENROUTER_API_KEY`. No personal key is used.

`CARD_BUDGET` is an optional finite nonnegative USD limit; absent/blank is unlimited,
and zero admits no new paid call. It is an advisory process-local budget, resets on
restart and does not reserve concurrent spend. Persistent product quotas and
idempotency remain the Donut backend's responsibility.

Linux cutout jobs run one at a time across card keys to bound segmentation memory;
requests for the same key continue sharing one in-flight Promise. Failure is
returned to the caller and does not strand later tasks. No provider retry is added.

The upstream `done` and layer status contract is preserved: a main image can exist
while layers are pending or unusable. The product adapter must require all three
usable assets before reveal; fallback and same-image cutout retry are pending
product decision. This worker does not implement six-month retention, public result
link expiry or durable interrupted-job recovery. Do not treat worker health as full
identity-card acceptance.

`GET /healthz` includes `source_revision`, `auth_required` and `budget_limit_usd`;
it does not expose credentials. Verify these along with every serving Pod digest,
unauthorized 401 and three real output files after deployment.
