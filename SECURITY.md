# Security and privacy boundary

DeepSeek Harness remains the runtime and policy boundary. Honcho is a fallible remote memory service. Recalled text is
untrusted data and never overrides current files, tests, explicit user corrections, DSH policy, or the session log.

Remote capture and automatic recall are off by default. When enabled, selected normalized text leaves the host for the
configured hosted or self-hosted Honcho service. Operators own consent, retention, export, and deletion procedures. The
local outbox can retain redacted conversation text after a crash and must be placed on a private volume with restricted
access, backup, and deletion policy. Regex redaction reduces obvious bearer/API/private-key leakage but is not complete
data-loss prevention.

The API key remains in the DSH host provider. It is excluded from model messages, session events, diagnostics, fixtures,
cards, artifact objects, and RLM kernels. This project does not sandbox DSH, tools, Honcho, or DeepSeek RLM; isolate
untrusted code with operating system or container controls.

Artifact memory is off by default. When enabled, exact bytes remain beneath a separate host-configured, project-keyed
artifact root. Treat that root as sensitive scientific/user data: it may contain secrets, personal information, licensed
datasets, or regulated records even though its card is sanitized. Restrict it to the DSH host account, encrypt it where
required, exclude it from source control and routine telemetry, and define backup, export, retention, deletion, and
backup-deletion ownership before use. v0.2 performs no automatic garbage collection; deletion and orphan inspection are
operator-only and absent from model tools.

The artifact root and RLM artifact root must be absolute, distinct, non-overlapping, and outside filesystem/home,
repository, DSH profile, and Honcho outbox roots. Ingest is limited to a regular, single-link file beneath the exact live
DSH session's RLM `exports/` directory. Component and canonical containment, symlink/junction/reparse detection, streamed
mutation checks, atomic publication, size, and SHA-256 are enforced, but these checks are not an OS sandbox. A kernel with
the same operating-system authority can still inspect or mutate files it is otherwise permitted to access.

Honcho artifact egress is an explicit allowlist. The message sender is the configured assistant peer. Its bounded content
contains the untrusted-card label, title, summary, source label/version, optional shape/column/tag labels, experiment ID,
artifact ID, query fingerprint, and the current-truth warning. Projection metadata contains only
`content_classification`, `remote_card_schema_version`, `experiment_id`, `artifact_id`, `project_id`,
`query_fingerprint`, `source_version`, `source_label`, `title`, `summary`, optional `shape`/`columns`/`tags`,
`artifact_schema_version`, `plugin_version`, `projection_revision`, and optional `dsh_tool_call_id`. The existing SDK
provider adds its host-controlled transport envelope: `source`, `schema_version`, `delivery_id`, `message_fingerprint`,
`dsh_session_id`, `dsh_agent_kind`, `project_id`, `human_peer_id`, `role`, and `plugin_version`. Workspace, configured
user/assistant peers, and the deterministic session ID are also used for ordinary Honcho scope provisioning and search;
none is model-selected. All free text is normalized, redacted, and bounded first.

Honcho does not receive artifact bytes, SHA-256, local or resolved paths, raw SQL/Python/query text, parameters, row
samples, connection strings, environment values, credentials, origin session paths, or opaque metadata. Cards are
assistant/project observations—not human preferences—and are always presented as untrusted historical metadata
subordinate to current files, datasets, tests, corrections, and DSH policy. Remote search parses experiment-card
metadata only when the provider envelope role is also `experiment-card`.

On Windows, a persistent per-user `HONCHO_API_KEY` environment variable survives reboot but is not a credential vault:
other processes running as that Windows user can generally read it. Prefer a dedicated key, restrict the user account,
and rotate the key after suspected host compromise. Keep live-test provisioning and cleanup flags process-scoped.

Report vulnerabilities privately to the repository maintainers. Do not include live keys, peer IDs, or conversation
content in reports.
