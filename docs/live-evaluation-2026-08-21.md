# Hosted synthetic evaluation — 2026-08-21

This is a content-free evidence record for the hosted Honcho evaluation. It contains no prompt, response, query, recalled memory, credential, peer/workspace ID, or remote error message.

## Scope and controls

- Provider: hosted Honcho at `https://api.honcho.dev` through `@honcho-ai/sdk@2.3.0`.
- Corpus: 12 synthetic cases covering preference, workspace/project/peer isolation, correction, freshness, sparse evidence, stored prompt injection, subagent exclusion, outage, and long-history bounds.
- Resources: two freshly provisioned, run-prefixed synthetic workspaces; no personal or production identities.
- Data policy: the repository operator approved hosted synthetic use and provider API-log/encrypted-backup retention up to 90 days.
- Artifacts: content assertions reject the API key and every corpus prompt/query/evidence string before a report or manifest is written.

## Results

| Metric                                     |                               Evidence |
| ------------------------------------------ | -------------------------------------: |
| Latest attempt                             |                           12/12 passed |
| Protected-case pass rate                   |                                   100% |
| Latest leakage failures                    |                                      0 |
| Preserved aggregate attempts               |                                      3 |
| Cases observed passing across aggregate    |                                  12/12 |
| Leakage failures across attempts           |                                      0 |
| Normal completions across attempts         |                                   100% |
| Token-bound checks across attempts         |                                   100% |
| Latency-bound or clean-fail-open checks    |                                   100% |
| Timeout/fail-open rate                     |           11/36 case-attempts (30.56%) |
| Latest p95 added first-step time           |                                1512 ms |
| Largest per-case aggregate p95             |                                1515 ms |
| Largest latest injected context            | 1878 characters / 470 estimated tokens |
| Memory-disabled required-hit rate          |                                     0% |
| Best live memory-enabled required-hit rate |                                   100% |
| Per-request cost                           |               Unavailable in SDK 2.3.0 |

The raw 1500 ms latency target was not met: latest p95 was 1512 ms. Promotion relies on the specification's alternative clean timeout/fail-open clause, not on claiming the latency target passed. The initial bounded processing wait ended after 120457 ms with 13 work units still pending and none completed. The provider was changed to preserve an already-successful project search when the global representation path is delayed; both paths must fail before combined recall fails open with no memory.

Four live attempts were executed in total. The initial provisioning attempt produced the first report before attempt-preserving resumes existed; three later reports form the retained aggregate. Runner-level activity across the executed attempts was two workspace creations, ten record calls, 48 recall attempts, and 320 queue-status polls. Exact SDK HTTP request counts and monetary cost were unavailable because retries and billing usage are not exposed by SDK 2.3.0.

## Cleanup

The first cleanup invocation reached its 60-second workspace-absence bound after clearing the first workspace's sessions. Cleanup was then corrected to delete sessions across all fenced workspaces before concurrent workspace deletion. The second invocation verified both workspaces absent between `2026-08-21T08:02:21.459Z` and `2026-08-21T08:02:39.444Z`. The run-specific local outbox/state directory was also removed. Provider-side API logs and encrypted backups remain subject to the approved rolling retention window of up to 90 days.

## Promotion interpretation

The local content-free multi-attempt aggregate has no remaining blockers and records `promotionClaimed: true`. This claim is limited to the section 22 synthetic promotion criteria. It does not enable capture or recall by default, publish a package, prove the raw latency target, remove the non-sandbox limitation, or turn Honcho memory into authoritative repository evidence.
