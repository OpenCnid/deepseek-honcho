# `@deepseek-honcho/dsh-artifact-memory`

Optional v0.2 exact-result storage for DeepSeek Harness. It stores immutable bytes and validated experiment cards beneath one host-configured project root. Honcho receives only a bounded allowlisted card projection; it never owns artifact bytes or local paths.

The package is disabled unless explicitly mounted and configured. Source ingest is limited to `sessions/<exact DSH SessionId>/exports` beneath the configured DeepSeek RLM artifact root. Resolution revalidates current-project containment, size, and SHA-256 before returning a short-lived path through DSH ToolRuntime.

There is no model-facing deletion, cleanup, arbitrary-read, project selection, peer selection, shell, or raw-provider operation. Retention, export, backup, deletion, and orphan inspection are operator responsibilities.
