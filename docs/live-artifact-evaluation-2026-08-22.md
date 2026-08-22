# Hosted artifact/RLM proof — 2026-08-22

This is a content-free evidence record for the v0.2 hosted Honcho artifact check. It contains no artifact content, local path, raw query, credential, peer/workspace/project/session identifier, integrity digest, or remote error message.

## Scope and controls

- Provider: hosted Honcho at `https://api.honcho.dev` through exact `@honcho-ai/sdk@2.3.0`.
- Compute: DeepSeek RLM `79b6b28e16c7305e8e791f2d8c9d2935e75ade60` plus the approved optional-ToolRuntime patch.
- Harness: exact DSH `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`).
- Resource isolation: one freshly provisioned synthetic workspace with generated human, assistant, project, and two DSH session identities; no personal or production memory.
- Data policy: the resource manifest was written before provisioning. The remote workspace is retained for inspection and remains marked for explicit operator cleanup.

## Results

| Check                                                               |           Result |
| ------------------------------------------------------------------- | ---------------: |
| Real pinned RLM kernel                                              |           Passed |
| Record only through `dsh_tools.call("memory_artifact_record", ...)` |           Passed |
| Honcho credential absent from the kernel                            |           Passed |
| Exact assistant-authored backend projection stored                  |           Passed |
| Correct project, peer, and session scope                            |           Passed |
| Distinct later-session Honcho semantic hit                          |           Passed |
| Semantic hit bound to the current-project local card                |           Passed |
| Exact local artifact size                                           | 17,825,793 bytes |
| Exact SHA-256 verification                                          |           Passed |
| Source-version freshness                                            |            Fresh |
| Bounded Python slice load                                           |           Passed |
| Hosted semantic-hit latency                                         |         1,354 ms |
| End-to-end duration                                                 |        15,348 ms |
| Sanitized backend projection size                                   |      2,006 bytes |
| Artifact bytes sent to Honcho                                       |                0 |
| Local paths sent to Honcho                                          |                0 |
| Raw query text sent to Honcho                                       |                0 |
| Credentials sent to Honcho or RLM                                   |                0 |

The backend message content matched the locally constructed allowlisted projection exactly. Its additive delivery metadata also matched the deterministic delivery ID and configured assistant, human, project, and origin-session authority. A distinct later RLM session found the card through hosted Honcho search, resolved it only through the DSH artifact tool, verified the full local object, and printed only a bounded marker slice.

## Retention and cleanup

The check is deliberately non-destructive. Its ignored local JSON report and resource manifest retain the generated remote identifiers needed for fenced operator inspection and deletion. The hosted synthetic workspace has not been deleted. Provider-side API logs and encrypted backups remain subject to the approved rolling retention window of up to 90 days after operator deletion.
