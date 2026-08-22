# Native bundle example

This profile fragment assumes the surrounding DSH host already owns ToolRuntime, agents, models, policy, logging, and session persistence. The bundle adds Honcho and the explicitly enabled artifact extension. Automatic capture and recall are explicitly enabled in the example; omit `agentMemory` to keep both off. Omit `artifactMemory` (or set it to `false`) to retain exactly the original five memory tools and no artifact service.

Set `HONCHO_API_KEY` only in the host process and replace every synthetic ID. `stateRoot`, `artifactRoot`, and `rlmArtifactRoot` must be absolute private paths. The three roots must be distinct and non-overlapping; keep them outside the repository, home/profile, filesystem root, and ordinary telemetry. The same components may instead be mounted independently when an application needs a different provider or only one Consumer.

The example is hosted by default. For a self-hosted Honcho API, change `baseURL` to the operator-controlled HTTP(S) endpoint; no AGPL server code is included here.

`rlm.cordis.patch.yml` shows the separate RLM contract needed for `await dsh_tools.call("memory_search", {...})`, `memory_artifact_record`, and `memory_artifact_resolve`: enable only the RLM tools adapter and leave kernel `envAllowlist` and `env` empty. In particular, never allowlist `HONCHO_API_KEY`. The configured RLM `artifactRoot` must exactly match `artifactMemory.rlmArtifactRoot`; Python writes intentional results only beneath `Path(os.environ["RLM_SESSION_DIR"]) / "exports"`. Calls return through DSH ToolRuntime policy/telemetry while the SDK provider and key stay in the host.

Recording and resolving from Python use the actual schemas:

```python
from pathlib import Path
import os

exports = Path(os.environ["RLM_SESSION_DIR"]) / "exports"
exports.mkdir(parents=True, exist_ok=True)
result_path = exports / "synthetic-result.bin"

recorded = await dsh_tools.call("memory_artifact_record", {
    "source_path": str(result_path),
    "title": "Synthetic cohort aggregate",
    "summary": "Aggregate result for the bounded synthetic cohort.",
    "query_fingerprint": stable_lowercase_sha256,
    "source": "synthetic-warehouse",
    "source_version": immutable_snapshot_id,
    "media_type": "application/octet-stream",
    "tags": ["synthetic", "cohort"],
})

resolved = await dsh_tools.call("memory_artifact_resolve", {
    "experiment_id": recorded["value"]["experiment_id"],
    "current_source_version": immutable_snapshot_id,
})
with open(resolved["value"]["path"], "rb") as stream:
    deliberate_slice = stream.read(64)
```

The outer bridge result contains `isError` and `value`, as shown. Delete large Python values and resolved-path variables when they are no longer needed. The kernel is not a sandbox, and v0.2 provides no automatic artifact deletion or garbage collection.
