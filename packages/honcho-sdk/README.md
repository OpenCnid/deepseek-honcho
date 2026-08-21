# @deepseek-honcho/dsh-honcho-sdk

Host-only `ctx.honcho` provider using exactly `@honcho-ai/sdk@2.3.0`. It reads a key from the host-selected environment variable, validates a fixed workspace/human/project identity, and never exports the raw SDK/client.

`record()` resolves after an atomic redacted local outbox write, not remote upload. The background worker implements retry/backoff, circuit breaking, metadata-filter deduplication, per-session ordering, cross-session concurrency, dead letters, shutdown drain, and HMR/process fencing. Recall/search are bounded and cancelable. Combined recall returns a bounded partial success when either global representation or project search succeeds, so asynchronous derivation lag cannot discard an already-available search result. Model token cost is zero unless a Consumer renders returned items.

The provider exposes a single Cordis `honcho` service and owns one worker for its absolute `stateRoot`. Do not mount two providers against the same state root. Workspace creation defaults off; assistant observation defaults off. See the root operator guide before enabling data egress.
