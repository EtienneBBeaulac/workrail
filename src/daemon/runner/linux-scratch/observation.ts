import { z } from 'zod';
import type { SupervisorState } from '../../../answer-v1/supervisor-state.js';
import type { DockerCli } from './docker-cli.js';
import { scratchContainerName } from './identity.js';

const ContainerId = z.string().regex(/^[a-f0-9]{64}$/);
const Daemon = z.object({ ID: z.string().min(1), OSType: z.literal('linux') });
const Container = z.array(z.object({ Id: ContainerId, Name: z.string(),
  State: z.object({ Running: z.boolean() }), Config: z.object({ Labels: z.record(z.string()).nullable().optional() }),
})).length(1);
const LABEL = 'workrail.linux-scratch';

export type ScratchObservation =
  | Readonly<{ kind: 'no_intent' }>
  | Readonly<{ kind: 'missing_daemon_identity' }>
  | Readonly<{ kind: 'identity_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'absent_at_observation'; daemon: string; supervisor: string }>
  | Readonly<{ kind: 'present'; daemon: string; supervisor: string; container: string; phase: 'running' | 'stopped' }>;

function parse<T>(bytes: Buffer, schema: z.ZodType<T>): T | undefined {
  try { return schema.parse(JSON.parse(bytes.toString('utf8'))); } catch { return undefined; }
}

/** Read-only diagnosis on the explicitly supplied Docker endpoint. Even a successful
 * absence observation does not prove that an earlier create cannot settle later. No
 * result grants teardown, owner release, inference, or deadline continuity. */
export async function observeScratchResource(state: SupervisorState,
  docker: Pick<DockerCli, 'run'>, signal: AbortSignal,
  retainedBinding?: Readonly<{ daemon: string; container: string }>): Promise<ScratchObservation> {
  if (signal.aborted) return { kind: 'unavailable' };
  if (state.kind === 'absent') return { kind: 'no_intent' };
  const prior = state.kind === 'unconfirmed' ? state.pending : state;
  const { supervisor } = prior.intent;
  const original = 'binding' in prior ? prior.binding : undefined;
  if (retainedBinding && original && (retainedBinding.daemon !== original.daemon
    || retainedBinding.container !== original.environment)) return { kind: 'identity_mismatch' };
  // A cleanup observation is a separate durable identity, never a fabricated create receipt.
  const binding = retainedBinding ? { daemon: retainedBinding.daemon, environment: retainedBinding.container } : original;
  const daemon = prior.intent.daemon ?? binding?.daemon;
  if (!daemon) return { kind: 'missing_daemon_identity' };
  if (binding && (binding.daemon !== daemon || !ContainerId.safeParse(binding.environment).success)) return { kind: 'identity_mismatch' };
  try {
    const before = await docker.run(['info', '--format', '{{json .}}'], signal);
    if (before.kind !== 'completed') return { kind: 'unavailable' };
    const identity = parse(before.bytes, Daemon);
    if (!identity) return { kind: 'unavailable' };
    if (identity.ID !== daemon) return { kind: 'identity_mismatch' };
    // Positive listing evidence distinguishes absence from an inspect transport failure.
    // The label scopes unknown-create discovery; every returned ID is checked again.
    const filters = [`label=${LABEL}=${supervisor}`, `name=${scratchContainerName(supervisor)}`,
      ...(binding ? [`id=${binding.environment}`] : [])];
    const ids = new Set<string>();
    for (const filter of filters) {
      const listed = await docker.run(['ps', '--all', '--no-trunc', '--filter', filter, '--format', '{{json .ID}}'], signal);
      if (listed.kind !== 'completed') return { kind: 'unavailable' };
      const lines = listed.bytes.toString('utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 128) return { kind: 'unavailable' };
      for (const line of lines) {
        const id = parse(Buffer.from(line), ContainerId);
        if (!id) return { kind: 'unavailable' };
        ids.add(id);
      }
    }
    if (ids.size > 1) return { kind: 'identity_mismatch' };
    let observation: ScratchObservation = { kind: 'absent_at_observation', daemon, supervisor };
    if (ids.size === 1) {
      const id = [...ids][0]!;
      if (binding && id !== binding.environment) return { kind: 'identity_mismatch' };
      const inspected = await docker.run(['inspect', id], signal);
      if (inspected.kind !== 'completed') return { kind: 'unavailable' };
      const container = parse(inspected.bytes, Container)?.[0];
      if (!container) return { kind: 'unavailable' };
      if (container.Id !== id || container.Config.Labels?.[LABEL] !== supervisor
        || container.Name !== '/' + scratchContainerName(supervisor)) return { kind: 'identity_mismatch' };
      observation = { kind: 'present', daemon, supervisor, container: id, phase: container.State.Running ? 'running' : 'stopped' };
    }
    const after = await docker.run(['info', '--format', '{{json .}}'], signal);
    if (after.kind !== 'completed' || signal.aborted) return { kind: 'unavailable' };
    const confirmed = parse(after.bytes, Daemon);
    return !confirmed ? { kind: 'unavailable' } : confirmed.ID !== daemon ? { kind: 'identity_mismatch' } : observation;
  } catch { return { kind: 'unavailable' }; }
}
