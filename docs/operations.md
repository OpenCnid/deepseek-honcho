# Operator guide

## Identity and configuration

Choose one Honcho workspace, one human peer, and one project ID in host configuration. IDs must match `[A-Za-z0-9_-]{1,512}`. They are not model arguments. DSH session IDs are mapped to `dsh_` plus lower-case unpadded RFC 4648 base32 of SHA-256.

Keep the API key in the DSH host environment. `apiKeyEnv` is only the name of that variable. Place `stateRoot` on an absolute private path that is not a filesystem root, shared with no other bundle instance. Workspace auto-creation defaults off; peer/session creation defaults on; assistant observation defaults off.

Hosted and self-hosted deployments have the same trust model: selected captured text and queries leave DSH for the configured `baseURL`. Verify TLS, access control, backup, regional, and retention properties of that endpoint.

## Outbox operations

`stateRoot/outbox/pending` contains one `deepseek-honcho/v1` delivery per JSON file. `dead-letter` retains exhausted, invalid, or inconsistent deliveries. Directories are narrowed to owner access where the platform supports POSIX modes. Writes use a flushed temporary file plus an atomic same-directory publication. A worker lock fences concurrent HMR/process generations.

Both pending and dead-letter files contain regex-redacted but potentially sensitive message text. Regexes are not DLP. Encrypt and restrict the volume, exclude it from source control and ordinary telemetry, include it deliberately in backup policy, and monitor only content-free counts/timestamps/error codes. An open auth circuit does not discard data.

Before deleting outbox data, stop the DSH host and verify the exact absolute `stateRoot`. Back up or export required deliveries, then use an operator-owned deletion process. This project intentionally exposes no deletion tool or automatic live cleanup.

## Retention, export, and deletion

Before enabling capture, document consent, included data classes, destination, retention period, export owner, deletion owner/SLA, backup deletion, incident handling, and peer/workspace lifecycle. Use Honcho's operator/admin interface outside model context for remote export or deletion. Never grant those operations through the default memory tools.

Corrections are append-only: `memory_correct` writes new content with optional `supersedes` metadata. It does not delete old remote or local data. Legal or policy deletion remains an operator action.

## Live tests

The default test suite needs no key. To run an opt-in hosted or self-hosted smoke test, create an isolated non-production workspace and set:

```text
HONCHO_LIVE_TEST=1
HONCHO_API_KEY=<host-only key>
HONCHO_LIVE_WORKSPACE_ID=<isolated workspace>
HONCHO_BASE_URL=https://api.honcho.dev
```

Then run `pnpm test:e2e`. The fixture creates unique `synthetic_*` peers, project, and session IDs. It does not delete remote resources. Inspect them, record evidence without message content, and perform cleanup using the approved operator process. Never reuse a personal or production peer ID.

## Failure and shutdown behavior

Remote writes are asynchronous after local durability. Restart recovers pending files. Retry preserves per-session order while allowing other sessions to proceed. Ambiguous successes query `delivery_id` metadata and compare per-message fingerprints. Inconsistent partial delivery is dead-lettered. Auth/permission and repeated transient failures open the circuit. Shutdown drains for the configured bound; if work remains in flight, the generation fence is retained until it settles.

Recall timeout/outage/auth failure after valid startup fails open with no model-visible error prose. A missing key or invalid static configuration fails startup, because the host cannot safely promise local processing under an invalid identity/provider configuration.

## RLM

DeepSeek RLM kernels receive no ambient environment by default at the inspected revision. Keep `envAllowlist: []` and `env: {}`, or at minimum ensure `HONCHO_API_KEY` and every equivalent credential variable are absent. Enable `adapters.tools` and call memory only as `await dsh_tools.call("memory_search", {"query": "..."})`. That bridge dispatches through DSH `ctx.tools.execute`, preserving tool policy and result telemetry while the enclosing IPython call is open.

The kernel is still not a sandbox. Python, imports, files, sockets, subprocesses, and shell cells use kernel-process OS authority and can bypass DSH tool policy. Separate filesystem/network/process authority with an external operating-system or container sandbox. Environment omission protects the Honcho key but does not constrain other ambient machine access.
