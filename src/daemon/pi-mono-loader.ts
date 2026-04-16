/**
 * @deprecated Use src/daemon/agent-loop.ts instead.
 *
 * This module previously loaded @mariozechner/pi-agent-core and @mariozechner/pi-ai
 * (private npm packages). Those packages have been replaced by the first-party
 * AgentLoop in src/daemon/agent-loop.ts, which uses @anthropic-ai/sdk and
 * @anthropic-ai/bedrock-sdk (both public packages on npm).
 *
 * This file is kept for backward compatibility but is no longer imported by
 * workflow-runner.ts. It will be removed in a future version.
 */
