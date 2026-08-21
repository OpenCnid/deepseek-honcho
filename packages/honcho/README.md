# @deepseek-honcho/dsh-honcho

Provider-neutral `ctx.honcho` Cordis Service Definition, host identity mapping, normalized content sanitizer, stable errors, and SDK-free fake provider. It contains no credentials, model loop, model-visible tools, network client, or policy.

This package adds no model context or tokens by itself. Consumers call the service with the host-resolved scope; arbitrary workspace/human/project selection is not part of the interface. The service key is `honcho` and is intended to have exactly one provider in a Cordis context.
