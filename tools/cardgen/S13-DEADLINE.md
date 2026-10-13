# S13 receiver processing deadline

This describes the formal `worker.mjs` / `card-art-service.mjs` receiver. It does
not change the historical Fly mock or frontend. S13 gives an initial generation
one total 60-second processing interval, including admission, queue wait, main
validation, cutout and plate. Each explicitly admitted layers retry has its own
60-second interval. `expiresAt` remains the independent, immutable retention
boundary; retention expiry still blocks reads, writes and retry admission.

## Wire contract

| Location | Field | Meaning |
| --- | --- | --- |
| Initial POST body | `processingDeadlineAt` | Optional ISO UTC deadline ending in `Z` |
| Every job receipt | `processingDeadlineAt` | Immutable original initial deadline, including after retries |
| Retry-layers POST body | `processingDeadlineAt` | Optional deadline for this new derivative attempt |
| Retry receipt and subsequent lookups | `acceptedRetryProcessingDeadlineAt` | Deadline bound to `acceptedRetryToken` and `acceptedAttempt` |
| Health response | `processing_deadline_version: 1` | Receiver implements this deadline protocol |

New backend callers must persist their own admission deadline as a `Date`, send
its canonical `toISOString()` value and require the exact receipt echo. An
initial task keeps the same deadline on lookup and submission replay. Retry
waiting verifies both that original root deadline and the new accepted retry
deadline, token and attempt. The existing field name is `acceptedAttempt`.
Replaying an older retry token echoes that token's accepted deadline/attempt;
the root `attempt`, `retryToken` and asset manifest continue to describe the
current attempt. It never rewinds resources or creates another inference call.

For old callers, omission defaults once to receiver request receipt + 60000 ms.
Request receipt is captured before reading the body or preparing the avatar.
The queue stores `processingReceivedAt` and the accepted deadline durably.
Repeated initial identities return the stored original deadline. A new retry
token gets a new interval; replaying it preserves its first accepted interval.
Including an explicit retry deadline makes it part of the token fingerprint;
changing it under the same token is a conflict. Old six-field retry bodies stay
accepted and keep their original fingerprint semantics.

A deadline beyond receipt + 60000 ms, a non-UTC value or malformed date returns
400 `invalid_processing_deadline`. A deadline at or before receipt is accepted
as an already timed-out task and dispatches no provider/inference request.
Equivalent ISO inputs normalize to millisecond UTC; backend exact-echo checks
must use canonical ISO input. Existing authentication, request key, retention
expiry and expected worker contract checks still apply.

## Deadline decision and publication

The queue's independent timer settles queued, running and unresolved crashed
work. Reads also settle a due task. Before the deadline, interrupted paid work
remains `provider_result_unknown`; it is never redispatched after recovery.
At the deadline the last committed manifest determines the terminal result:

- Unvalidated main becomes `timed_out` with `provider_timeout` / `llm`.
- A validated ready main and all already successful layers remain immutable.
  Unfinished layers become `timed_out`, allowing a flat card from the same main.
- An earlier confirmed failure stays a confirmed failure. A completed task is
  not expired merely because its processing interval has elapsed.
- If all three assets are already qualified and durably ready, settlement and
  restart return `done` with the same 3D assets, even if terminal status
  bookkeeping crosses the deadline. It does not invent a plate failure.

A real worker budget refusal before dispatch is an immediate terminal receipt
with internal `error: "budget_not_dispatched"`, zero attempted provider requests
and private sample reason `budget_not_dispatched`. It never becomes an unknown
model result or a later LLM timeout. The backend must map this authenticated
cause to silent original-avatar/type-default fallback, skip image quality
review and regeneration capability, and keep budget details out of product
responses. This applies to initial and explicit replacement generations.

Ready assets require bytes, validation, guarded publication and a durable
checkpoint. Adapters write to unique attempt scratch paths. They receive an
abort signal; they never write borrowed successful assets. Only guarded
publication can replace an unfinished canonical asset. Active execution slots
remain held until an adapter actually settles, even if it ignores abort, so a
late cleanup cannot delete a later retry's output. Receipts and checkpoints
after the deadline are rejected; the terminal journal uses the preceding
committed snapshot, not a renderer's mutable record.

Resource qualification uses a durable completion witness. The event is the
observed return of artifact persistence and required resource directory syncs,
followed by canonical resource-journal persistence and its directory sync, with
the clock strictly before the fixed attempt deadline. The timestamp is captured
**after** those operations return. Witness persistence, rollback-marker cleanup
and terminal bookkeeping may finish later. They cannot qualify a resource whose
actual persistence acknowledgment crosses the deadline. Backend publication
still uses its own fixed-deadline CAS: a late worker witness cannot replace a
backend timeout/fallback that was already committed.

Before replacing a canonical journal, the writer atomically saves and syncs an
independent `.JOB.anchor` containing the preceding confirmed snapshot and its
proof. Active replacement also preserves the preceding journal inode in
`.JOB.checkpoint`. After the resource journal sync returns before D, the writer
creates `.JOB.witness`, binding the exact canonical SHA256, job, attempt,
original deadline, attempt deadline and observed qualification timestamp. Each
ready resource has an immutable attestation binding its manifest hash and the
canonical hash at its qualification event. Later snapshots carry those earlier
attestations; bookkeeping cannot introduce a new ready resource. A newly
introduced attestation must name the current checkpoint attempt and its
admission. A derivative's proof attempt must match the ready asset's attempt;
main is qualified by the initial attempt. Borrowed successful assets keep their
earlier proofs unchanged, even when initial and retry deadlines overlap.

Recovery requires a valid witness matching the canonical snapshot and all ready
resources. Missing, malformed, mismatched or late qualification evidence uses
the independently validated preceding anchor, even when a canonical asset file
exists. A valid candidate witness can survive a crash before marker removal.
The anchor stays retained after cleanup and is refreshed only before the next
replacement, while the preceding canonical/witness is still recoverable. An
initial anchor contains the zero-dispatch queued identity. Legacy resources are
preserved as legacy attestations, without inventing pre-deadline timestamps.
Corrupt anchor or admission identity fails startup before dispatch.

This completion-witness definition explicitly supersedes the earlier parent
full-function-return strict-A interpretation. Those counterexamples and RED
snapshots remain historical evidence; they are not reclassified as passing.
The revised protocol requires independent review of its actual crash transitions.
The canonical 16 KiB record limit is unchanged. A witness is bounded to 4 KiB;
the single preceding anchor is bounded to one record plus one witness and a
small envelope. Hard links, atomic rename, file/directory fsync and a single
writer are required. Anchors, witnesses, markers and exact temporary paths are
included in bounded retention cleanup. An old writer must not reopen these
journals during rollback.

Retention purges owned personal assets first, then unlinks the canonical journal
and waits for the journal directory sync and close. Only after that durable
identity retirement can it delete the anchor, witness and marker, followed by
another directory sync. A failed retirement sync preserves recovery evidence
and in-memory ownership. A crash before retirement may recover the expired
journal with its proof and remove it before any dispatch; a crash after
retirement leaves only bounded orphan proof files. Those files cannot revive an
expired identity or prevent unrelated confirmed history from recovering.

OpenRouter POST/download, Bedrock pacing/SDK calls and Python validation/plate
processes receive the signal. Aborting an active resident IS-Net inference
kills that task's resident process, waits for it to close, and initializes one
fresh resident under the existing startup timeout. It never repeats the canceled
inference. Health is unavailable during replacement and returns healthy when
initialization succeeds. Old resident frames and process callbacks cannot affect
the replacement. The serial queue and one-process limit remain enforced.
Actual engine timeout/crash/protocol failure, an unexpected abort or failed
replacement initialization remains a sticky component fault, with no retry loop
or provider fallback. A provider may have accepted billing before cancellation, and a
provider that ignores abort can continue remotely. Durable local fences prevent
its late result from changing receipts or published assets. Shutdown drain is
still limited by adapters that ignore cancellation. Such an adapter also holds
its active execution slot and blocks a newer same-job retry until it settles;
this generic liveness limitation is distinct from IS-Net task recovery.

Receipts recheck the processing decision and committed result after asynchronous
asset verification, so a read crossing the deadline projects the terminal
manifest. Successful assets remain subject to hash and retention verification.

## Upgrade and compatibility

Deploy the receiver first. Explicit backend deadlines require both a healthy
receiver advertising version 1 and exact deadline echoes. A health response
from one upgraded target cannot prove that another old target honors the body.
The single Recreate replica must finish replacement before enabling the sender;
an old writer must not reopen deadline/checkpoint journals during rollback.
An old receiver may ignore the initial field and reject the expanded retry body.

The frozen image model, prompt, pipeline and partial-layer result contract are
unchanged. Deployment still supplies the real `CARD_SOURCE_REVISION`; normal
expected-contract/source gates must bind to that revision. Successful older
assets keep their original provenance. Explicit retries can record the newer
execution revision under the existing retry contract. This is an additive
deadline capability, not a model or result-contract revision.

Legacy journals without an initial deadline are backfilled once from original
`createdAt` + 60000 ms, never from reboot time. Old retry entries have no receipt
timestamp: the candidate conservatively uses original `createdAt` + 60000 ms
for those entries too. Completed historical results remain readable; unresolved
ones may immediately time out. Parent confirmed this conservative legacy policy;
an exact retry receipt cannot be reconstructed from the old journal, and missing
history must never renew the interval or invent another charge. No live migration
or rollout is performed by these edits.

## Local verification

Use Node 24 and the package scripts through the shared build guard:
`npm run test:deadline`, `npm run test:failure-publication`, then `npm test`.
`npm run test:witness-review` isolates the retention/crash and overlapping
resource-attempt regressions from the completion-witness review.
Python 3 with Pillow is required for the real raster validation/plate fixtures.
Tests use local HTTP, offline provider fixtures and real lightweight IPC for
resident lifecycle checks. Budget-denial tests use the real image generator and
WorkerBudget with a forbidden fetch callback; none require live provider
credentials. Subset success does not establish full-suite success,
native ARM inference performance, deployed behavior or product acceptance.
