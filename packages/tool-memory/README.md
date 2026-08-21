# @deepseek-honcho/dsh-tool-memory

Registers exactly `memory_recall`, `memory_search`, `memory_record`, `memory_correct`, and `memory_status` in DSH ToolRuntime. All calls traverse DSH validation, pre-execution policy, execution wrappers, result telemetry, and normal AgentLoop logging when top-level.

Schemas accept focused query/note/correction content only. Workspace, project, human peer, API key, observation, derivation, and administration are not model-selectable. Recall/search are item/character/time bounded and return a warning that current files/tests are authoritative. Record/correct normalize, redact, and bound before the provider's local outbox. Status is content-free. The five schemas consume model context only when this Consumer is mounted.
