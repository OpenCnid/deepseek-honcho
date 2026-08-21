/**
 * Composable native DeepSeek Honcho bundle.
 *
 * This package mounts only the Honcho provider and its Consumers. It does not
 * own an AgentLoop, model adapter, policy service, credential prompt, or tool
 * runtime; the surrounding DeepSeek Harness host remains the control plane.
 * The named-export-only shape preserves the Loader-visible Config schema.
 * @module @deepseek-honcho/dsh-honcho-bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import HonchoSdkMemory, { type Config as ProviderConfig } from '@deepseek-honcho/dsh-honcho-sdk'
import * as agentMemory from '@deepseek-honcho/dsh-agent-memory'
import * as toolMemory from '@deepseek-honcho/dsh-tool-memory'

export const name = 'deepseek-honcho'

export interface Config {
  /** Required host-owned identity, credential-env name, and durable state root. */
  readonly provider: ProviderConfig
  /** Automatic capture/recall policy. Both modes default off. */
  readonly agentMemory?: agentMemory.Config
  /** Five model tools, all enabled when this Consumer is mounted. */
  readonly tools?: toolMemory.Config | false
}

export const Config: z<Config> = z.object({
  provider: HonchoSdkMemory.Config.required(),
  agentMemory: agentMemory.Config,
  tools: z.union([z.const(false), toolMemory.Config]),
})

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(HonchoSdkMemory, config.provider)
  ctx.plugin(agentMemory, config.agentMemory ?? { capture: 'off', recall: 'off' })
  if (config.tools !== false) ctx.plugin(toolMemory, config.tools ?? {})
}
