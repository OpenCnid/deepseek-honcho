# @deepseek-honcho/dsh-honcho-bundle

Named-export-only Cordis composition of the SDK Service Provider, lifecycle Consumer, five-tool Consumer, and explicitly enabled artifact-memory extension. Named exports retain the Loader-visible `Config` schema. Without `artifactMemory.enabled: true`, the original five tools and behavior are unchanged; enabling record and resolve adds exactly two artifact tools.

The bundle does not mount DSH AgentLoop, ToolRuntime, a model adapter, policy, logging, or credentials. `provider` is required. Automatic capture and recall default off; the tool Consumer is mounted by default and can be disabled with `tools: false`. Mount the packages separately to replace any layer without replacing the others.
