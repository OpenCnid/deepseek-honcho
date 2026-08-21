# MCP experiment operator guide

This is Stage A, not dependable lifecycle capture. It uses DSH's existing
`@deepseek-ai/dsh-mcp-client@0.1.0-rc.7` Streamable HTTP transport and publishes the Honcho server's broad MCP surface as
`mcp__honcho__*`. The native bundle later narrows the model surface to five memory tools.

1. Create an isolated synthetic Honcho workspace and peers. Never reuse production or personal peer IDs.
2. Set `HONCHO_API_KEY` and `HONCHO_WORKSPACE_ID` in the DSH host environment. For self-hosting, deploy the separately
   licensed Honcho MCP Worker and set `HONCHO_MCP_URL`; the Worker points at the Honcho API.
3. Add one of the checked-in profile fragments to the DSH Cordis profile.
4. Copy `skills/honcho-memory` under the configured DSH skill root and load it through DSH's normal skill tooling.
5. Run `pnpm evaluate` to materialize the content-free deterministic manifest. Execute each case in
   `tests/fixtures/evaluation-corpus.json` with only its synthetic workspace/peer/project, then record pass/fail, latency,
   token count, hit/miss/stale/contradictory classification, and request/cost numbers—never the conversation text.

The current checked-in report does not claim the promotion gate. A live run needs operator consent and isolated
credentials. Honcho insights are asynchronous, so do not poll after writes. Export and deletion are operator-owned; no
cleanup script is run automatically.

The MCP experiment cannot guarantee automatic capture, local durability, duplicate defense, root/subagent exclusion, or
delivery. It also exposes destructive server tools, which the skill tells the model not to call; that instruction is not
an authorization boundary. Use DSH tool policy to deny them during an experiment.
