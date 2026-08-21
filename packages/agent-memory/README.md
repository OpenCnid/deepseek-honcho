# @deepseek-honcho/dsh-agent-memory

Composable DSH lifecycle Consumer. `capture` and `recall` both default to `off`.

`completed-root-turns` correlates committed public session events and queues only completed root user/assistant exchanges after normalization, redaction, and character/byte bounds. It excludes child sessions, injected messages, tool calls/results, non-text attachments, hidden reasoning, partial streams, and incomplete/error turns.

`first-root-step` uses the public `agent/pre-step` waterfall and prepends one plugin-source user message on step 1. The default budget is five items, 1,200 estimated tokens, and 1,500 ms. Its explicit untrusted wrapper says current code/tests/corrections/policy win. Failures add no model-facing error prose. Runtime recall latency is bounded by the configured timeout; capture adds only local outbox admission outside the visible turn.
