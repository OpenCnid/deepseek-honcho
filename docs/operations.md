# Operator guide

## Identity and configuration

Choose one Honcho workspace, one human peer, and one project ID in host configuration. IDs must match `[A-Za-z0-9_-]{1,512}`. They are not model arguments. DSH session IDs are mapped to `dsh_` plus lower-case unpadded RFC 4648 base32 of SHA-256.

Keep the API key in the DSH host environment. `apiKeyEnv` is only the name of that variable. Place `stateRoot` on an absolute private path that is not a filesystem root, shared with no other bundle instance. Workspace auto-creation defaults off; peer/session creation defaults on; assistant observation defaults off.

Hosted and self-hosted deployments have the same trust model: selected captured text and queries leave DSH for the configured `baseURL`. Verify TLS, access control, backup, regional, and retention properties of that endpoint.

## Outbox operations

`stateRoot/outbox/pending` contains one `deepseek-honcho/v1` delivery per JSON file. `dead-letter` retains exhausted, invalid, or inconsistent deliveries. Directories are narrowed to owner access where the platform supports POSIX modes. Writes use a flushed temporary file plus an atomic same-directory publication. A worker lock fences concurrent HMR/process generations.

Both pending and dead-letter files contain regex-redacted but potentially sensitive message text. Regexes are not DLP. Encrypt and restrict the volume, exclude it from source control and ordinary telemetry, include it deliberately in backup policy, and monitor only content-free counts/timestamps/error codes. An open auth circuit does not discard data.

Before deleting outbox data, stop the DSH host and verify the exact absolute `stateRoot`. Back up or export required deliveries, then use an operator-owned deletion process. This project intentionally exposes no deletion tool or automatic live cleanup.

## Artifact-root operations

Artifact memory requires two separate absolute roots: `artifactMemory.artifactRoot` for durable project-local objects/cards and `artifactMemory.rlmArtifactRoot` matching the RLM provider's `artifactRoot`. Neither may be a filesystem root, home directory, repository root, DSH profile root, Honcho `stateRoot`, or nested within the other. Startup rejects known overlap, symlinks, junctions/reparse points, and unsafe existing components.

The durable layout is `artifactRoot/projects/<one-way-project-key>/objects/<prefix>/art_*` plus `cards/exp_*.json`, a temporary directory, and content-free lock files. Raw project IDs and source paths are not persisted in object filenames. Cards do contain the configured project ID and bounded experiment metadata, so both objects and cards remain sensitive. On POSIX, directories/files are created with owner-only intent; Windows operators must enforce equivalent ACLs on the containing volume.

Only files under `rlmArtifactRoot/sessions/<DSH-derived-session-id>/exports/` are ingestible. Do not point `rlmArtifactRoot` at a copied or model-selected tree. Session snapshots, manifests, connection files, harness state, directories, multiple-hard-link files, symlinks, junctions, and detectable reparse/link escapes are rejected. The RLM root remains RLM-owned; the artifact package never cleans it.

Back up objects and cards as one project unit. Restoring cards without their objects causes resolution to fail closed; restoring objects without cards leaves operator-inspectable orphans that are not searchable. There is no automatic garbage collection. Before any operator deletion, stop the host, resolve the exact project-key directory, export required cards/objects, account for outbox projections and remote Honcho retention separately, and use a recoverable operator process. No inspection, export, retention, deletion, purge, or orphan-cleanup operation is model-callable.

Pending or failed cards reconcile through the ordinary Honcho outbox on startup and at the configured bounded interval. `pending` means local bytes/card are committed but outbox admission failed; `queued` means the sanitized projection is durably in the local outbox, not necessarily semantically searchable. An outage never makes Honcho the source of artifact bytes. Missing or corrupt local bytes are not redownloaded and resolution fails closed.

For incident response, stop new records, preserve the project directory and Honcho outbox, record content-free counts/error codes, and verify size/SHA-256 through an operator-controlled process. Do not paste paths, cards, bytes, raw queries, project IDs, or credentials into routine logs or reports. Stale source-version results remain historical artifacts and must not be represented as current truth.

## Retention, export, and deletion

Before enabling capture, document consent, included data classes, destination, retention period, export owner, deletion owner/SLA, backup deletion, incident handling, and peer/workspace lifecycle. Use Honcho's operator/admin interface outside model context for remote export or deletion. Never grant those operations through the default memory tools.

Corrections are append-only: `memory_correct` writes new content with optional `supersedes` metadata. It does not delete old remote or local data. Legal or policy deletion remains an operator action.

### Approved hosted synthetic-evaluation policy

The repository operator approved this policy on 2026-08-21 for the isolated evaluation only:

- consent and data classes: deterministic synthetic prompts, responses, peer IDs, project IDs, session IDs, and content-free measurements only; no personal conversations, production identities, attachments, tool payloads, credentials, source secrets, or hidden reasoning;
- destination: hosted Honcho at `https://api.honcho.dev` in an evaluation-only workspace;
- retention: retain the local content-free report, but initiate deletion of primary remote evaluation resources within 24 hours after the run is accepted or abandoned;
- export: no conversation-content export; the repository may retain aggregate classifications, latency, bounded token/character counts, timeout/error categories, request counts, and cost when the API exposes it;
- ownership: the operator running the live evaluation owns deletion and must record content-free submission and verification timestamps;
- backup deletion: the operator accepts Honcho's stated API-log and rolling encrypted-backup retention of up to 90 days for this synthetic-only data;
- incident handling: stop live runs, revoke or rotate the key, preserve only content-free diagnostics, and use Honcho's support/privacy process when provider-side action is needed; and
- lifecycle: create unique `synthetic_*` peers, projects, and sessions in a dedicated workspace; never reuse personal or production resources.

This approval does not authorize personal-memory use or unfenced destructive cleanup. Cleanup must remain outside model tools and require an explicit operator invocation scoped to the exact evaluation workspace.

### Persistent Windows host variable

For a Windows-native DSH or Codex host, store `HONCHO_API_KEY` as a per-user environment variable by entering it through a masked PowerShell prompt. Do not place it in `config.toml`, `.env.example`, repository files, shell command arguments, or chat. A per-user environment variable survives reboot but is not a credential vault: processes running as the same Windows user can generally read it.

Run this once in a PowerShell terminal owned by the operator:

```powershell
$honchoSecret = Read-Host 'Honcho API key' -AsSecureString
$honchoSecretPointer = [IntPtr]::Zero
try {
  $honchoSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($honchoSecret)
  $honchoKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($honchoSecretPointer)
  if ([string]::IsNullOrWhiteSpace($honchoKey)) { throw 'The Honcho API key cannot be empty.' }
  [Environment]::SetEnvironmentVariable('HONCHO_API_KEY', $honchoKey, 'User')
  [Environment]::SetEnvironmentVariable('HONCHO_BASE_URL', 'https://api.honcho.dev', 'User')
  $env:HONCHO_API_KEY = $honchoKey
  $env:HONCHO_BASE_URL = 'https://api.honcho.dev'
} finally {
  if ($honchoSecretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($honchoSecretPointer)
  }
  Remove-Variable honchoKey, honchoSecret -ErrorAction SilentlyContinue
}
```

Verify presence without printing the key:

```powershell
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('HONCHO_API_KEY', 'User'))) {
  'HONCHO_API_KEY is missing'
} else {
  'HONCHO_API_KEY is configured'
}
```

To remove the persistent credential and the current shell copy:

```powershell
[Environment]::SetEnvironmentVariable('HONCHO_API_KEY', $null, 'User')
Remove-Item Env:HONCHO_API_KEY -ErrorAction SilentlyContinue
```

After setting or removing the variable, fully restart the host application so new agent and terminal processes inherit the updated environment. Keep `HONCHO_LIVE_TEST` session-scoped so an ordinary test run cannot contact Honcho accidentally.

## Live tests

The default test suite needs no key. To run an opt-in hosted or self-hosted smoke test, create an isolated non-production workspace and set:

```text
HONCHO_LIVE_TEST=1
HONCHO_API_KEY=<host-only key>
HONCHO_LIVE_WORKSPACE_ID=<isolated workspace>
HONCHO_BASE_URL=https://api.honcho.dev
```

Then run `pnpm test:e2e`. The fixture creates unique `synthetic_*` peers, project, and session IDs. It does not delete remote resources. Inspect them, record evidence without message content, and perform cleanup using the approved operator process. Never reuse a personal or production peer ID.

### Full live corpus

The promotion comparison uses freshly provisioned evaluation workspaces rather than `HONCHO_LIVE_WORKSPACE_ID`. The runner writes `evaluation-results/live-resource-manifest.json` before the first remote creation so an interrupted run remains cleanable. The manifest contains resource IDs and timestamps, never the key or conversation content.

Enable the two run-scoped creation flags only for the deliberate command:

```powershell
$env:HONCHO_LIVE_TEST = '1'
$env:HONCHO_LIVE_PROVISION = '1'
corepack pnpm@11.7.0 evaluate:live
Remove-Item Env:HONCHO_LIVE_TEST, Env:HONCHO_LIVE_PROVISION -ErrorAction SilentlyContinue
```

The runner creates two `dsh_synthetic_eval_*` workspaces for explicit cross-workspace isolation, uses only `synthetic_*` peers/projects/sessions, bounds processing waits, and writes `evaluation-results/live-latest.json` without prompts, responses, queries, recalled text, keys, or remote error messages. `@honcho-ai/sdk@2.3.0` does not expose per-request billing, so the report records cost as unavailable instead of estimating it.

If asynchronous processing remains pending or individual reads time out, reuse the manifest without recording new messages or creating resources:

```powershell
$env:HONCHO_LIVE_TEST = '1'
$env:HONCHO_LIVE_RESUME = '1'
corepack pnpm@11.7.0 resume:live
Remove-Item Env:HONCHO_LIVE_TEST, Env:HONCHO_LIVE_RESUME -ErrorAction SilentlyContinue
```

Each resume writes a separate content-free attempt and refreshes a multi-attempt aggregate. The aggregate reports pass and timeout rates rather than hiding transient failures behind a selected attempt.

After inspecting the content-free result, invoke destructive cleanup separately:

```powershell
$env:HONCHO_LIVE_CLEANUP = '1'
corepack pnpm@11.7.0 cleanup:live
Remove-Item Env:HONCHO_LIVE_CLEANUP -ErrorAction SilentlyContinue
```

Cleanup refuses non-owned or non-prefixed workspaces, verifies the run/corpus metadata before deletion, submits session deletion for every workspace before concurrent workspace deletion, waits boundedly for asynchronous absence, and records content-free submission/verification timestamps. It never exposes an administration operation as a model tool. Only the aggregate report may claim promotion, and only after verified cleanup plus all isolation, protected-case, token, normal-completion, fail-open, and baseline-improvement checks pass.

## Failure and shutdown behavior

Remote writes are asynchronous after local durability. Restart recovers pending files. Retry preserves per-session order while allowing other sessions to proceed. Ambiguous successes query `delivery_id` metadata and compare per-message fingerprints. Inconsistent partial delivery is dead-lettered. Auth/permission and repeated transient failures open the circuit. Shutdown drains for the configured bound; if work remains in flight, the generation fence is retained until it settles.

Recall timeout/outage/auth failure after valid startup fails open with no model-visible error prose. A missing key or invalid static configuration fails startup, because the host cannot safely promise local processing under an invalid identity/provider configuration.

## RLM

DeepSeek RLM kernels receive no ambient environment by default at the inspected revision. Keep `envAllowlist: []` and `env: {}`, or at minimum ensure `HONCHO_API_KEY` and every equivalent credential variable are absent. Enable `adapters.tools` and call memory only as `await dsh_tools.call("memory_search", {"query": "..."})`. That bridge dispatches through DSH `ctx.tools.execute`, preserving tool policy and result telemetry while the enclosing IPython call is open.

The kernel is still not a sandbox. Python, imports, files, sockets, subprocesses, and shell cells use kernel-process OS authority and can bypass DSH tool policy. Separate filesystem/network/process authority with an external operating-system or container sandbox. Environment omission protects the Honcho key but does not constrain other ambient machine access.
