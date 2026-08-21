# Native bundle example

This profile fragment assumes the surrounding DSH host already owns ToolRuntime, agents, models, policy, logging, and session persistence. The bundle adds Honcho only. Automatic capture and recall are explicitly enabled in the example; omit `agentMemory` to keep both off.

Set `HONCHO_API_KEY` only in the host process and replace every synthetic ID. `stateRoot` must be an absolute private path. The same components may instead be mounted independently when an application needs a different provider or only one Consumer.

The example is hosted by default. For a self-hosted Honcho API, change `baseURL` to the operator-controlled HTTP(S) endpoint; no AGPL server code is included here.

`rlm.cordis.patch.yml` shows the separate RLM contract needed for `await dsh_tools.call("memory_search", {...})`: enable only the RLM tools adapter and leave kernel `envAllowlist` and `env` empty. In particular, never allowlist `HONCHO_API_KEY`. The call then returns through DSH ToolRuntime policy/telemetry while the SDK provider and key stay in the host.
