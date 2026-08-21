# Security and privacy boundary

DeepSeek Harness remains the runtime and policy boundary. Honcho is a fallible remote memory service. Recalled text is
untrusted data and never overrides current files, tests, explicit user corrections, DSH policy, or the session log.

Remote capture and automatic recall are off by default. When enabled, selected normalized text leaves the host for the
configured hosted or self-hosted Honcho service. Operators own consent, retention, export, and deletion procedures. The
local outbox can retain redacted conversation text after a crash and must be placed on a private volume with restricted
access, backup, and deletion policy. Regex redaction reduces obvious bearer/API/private-key leakage but is not complete
data-loss prevention.

The API key remains in the DSH host provider. It is excluded from model messages, session events, diagnostics, fixtures,
and RLM kernels. This project does not sandbox DSH, tools, Honcho, or DeepSeek RLM; isolate untrusted code with operating
system or container controls.

On Windows, a persistent per-user `HONCHO_API_KEY` environment variable survives reboot but is not a credential vault:
other processes running as that Windows user can generally read it. Prefer a dedicated key, restrict the user account,
and rotate the key after suspected host compromise. Keep live-test provisioning and cleanup flags process-scoped.

Report vulnerabilities privately to the repository maintainers. Do not include live keys, peer IDs, or conversation
content in reports.
