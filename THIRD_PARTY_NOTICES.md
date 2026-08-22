# Third-party notices

This project is licensed under Apache-2.0. Dependencies retain their own licenses.

- DeepSeek Harness packages are consumed at `0.1.0-rc.7`, corresponding to revision
  `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, under MIT. No DSH source is copied.
- `@honcho-ai/sdk` is consumed at exactly `2.3.0`, from the Honcho revision
  `ddbb90e36f2d148c7982f6ed85b09d31cabf5944`, under Apache-2.0.
- The Honcho server and MCP repository is AGPL-3.0. It was reviewed only to confirm its public protocol and SDK
  contracts. No server, MCP, or Honcho skill source is copied or adapted into the native packages.
- DeepSeek RLM revision `79b6b28e16c7305e8e791f2d8c9d2935e75ade60` is MIT. Its public session-filesystem,
  snapshot, environment, IPython, and `dsh_tools.call` host-bridge contracts were inspected and exercised; it is not a
  package dependency and no source was copied into this repository. A user-approved, upstream-ready patch is maintained
  in the separate RLM checkout: its optional tool adapter resolves the live DSH ToolRuntime with Cordis `ctx.get()` at
  two dispatch sites and adds a real nested-call regression test. That RLM change remains under MIT.

The lockfile is the machine-verifiable dependency inventory. See `provenance/upstreams.json` for revisions and use.
