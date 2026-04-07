import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ApiResponse, ConsoleSessionListResponse, ConsoleSessionDetail, ConsoleNodeDetail, ConsoleWorktreeListResponse, ConsoleWorkflowListResponse, ConsoleWorkflowDetail, PerfToolCallsResponse } from './types';

// Typed HTTP error so callers can check status without brittle string parsing.
export class HttpError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'HttpError';
  }
}

async function fetchApi<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status, res.statusText);
  const json: ApiResponse<T> = await res.json();
  if (!json.success || !json.data) throw new Error(json.error ?? 'Unknown error');
  return json.data;
}

export function useSessionList() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => fetchApi<ConsoleSessionListResponse>('/api/v2/sessions'),
    refetchInterval: 30_000, // fallback poll every 30s -- SSE handles real-time updates
    staleTime: 25_000,
  });
}

export function useSessionDetail(sessionId: string) {
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => fetchApi<ConsoleSessionDetail>(`/api/v2/sessions/${sessionId}`),
    enabled: !!sessionId,
    refetchInterval: 5_000,           // poll while viewing -- session detail changes frequently
    refetchIntervalInBackground: false, // F5: don't poll background tabs
    staleTime: 3_000,
  });
}

export function useNodeDetail(sessionId: string, nodeId: string | null) {
  return useQuery({
    queryKey: ['node', sessionId, nodeId],
    queryFn: () => fetchApi<ConsoleNodeDetail>(`/api/v2/sessions/${sessionId}/nodes/${nodeId}`),
    enabled: !!nodeId,
  });
}

export function useWorktreeList() {
  return useQuery({
    queryKey: ['worktrees'],
    queryFn: () => fetchApi<ConsoleWorktreeListResponse>('/api/v2/worktrees'),
    refetchInterval: 30_000, // refresh every 30s — each request loads all sessions + runs git
    staleTime: 20_000,       // keep showing previous data while refetching, no flash to loading
  });
}

export function useWorkflowList() {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => fetchApi<ConsoleWorkflowListResponse>('/api/v2/workflows'),
    staleTime: Infinity,
    refetchInterval: false,
  });
}

/** Discriminated result type for the perf tool calls hook. */
export type PerfToolCallsResult =
  | { readonly state: 'loading' }
  | { readonly state: 'devModeOff' }
  | { readonly state: 'error'; readonly message: string; readonly retry: () => void }
  | { readonly state: 'data'; readonly data: PerfToolCallsResponse };

export function usePerfToolCalls(): PerfToolCallsResult {
  const query = useQuery({
    queryKey: ['perf', 'tool-calls'],
    queryFn: async () => {
      try {
        return await fetchApi<PerfToolCallsResponse>('/api/v2/perf/tool-calls');
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // Sentinel value: server is running without WORKRAIL_DEV=1
          return null;
        }
        throw err;
      }
    },
    refetchInterval: 5_000,
    staleTime: 3_000,
    refetchIntervalInBackground: false,
  });

  if (query.isLoading) return { state: 'loading' };
  if (query.isError) {
    return {
      state: 'error',
      message: query.error instanceof Error ? query.error.message : 'Could not load performance data.',
      retry: () => void query.refetch(),
    };
  }
  if (query.data === null) return { state: 'devModeOff' };
  if (query.data === undefined) return { state: 'loading' };
  // Defense-in-depth: guard against future server change from 404-signaling to
  // devMode:false-signaling without a breaking schema change.
  if (query.data.devMode === false) return { state: 'devModeOff' };
  return { state: 'data', data: query.data };
}

export function useWorkflowDetail(workflowId: string | null) {
  return useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => fetchApi<ConsoleWorkflowDetail>(`/api/v2/workflows/${workflowId}`),
    enabled: workflowId !== null,
    staleTime: Infinity,
    refetchInterval: false,
  });
}

/**
 * Subscribes to the workspace SSE stream and invalidates the sessions query
 * immediately when the server detects a change. This gives near-instant UI
 * updates when a workflow advances, a status changes, or a new session starts.
 *
 * Worktrees are intentionally NOT invalidated here. Session writes (high
 * frequency -- every continue_workflow step) are semantically unrelated to
 * git worktree state (low frequency -- developer branch switches, commits).
 * Coupling them caused a CPU death spiral: session write -> SSE -> worktrees
 * refetch (606 concurrent git subprocesses, 12.5s) -> more session writes ->
 * repeat. Worktrees are now governed solely by their refetchInterval.
 *
 * Falls back to polling if the SSE connection drops or is unavailable.
 */
export function useWorkspaceEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource('/api/v2/workspace/events');

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { type: string };
          if (msg.type === 'change') {
            // Only invalidate sessions -- worktrees are governed by refetchInterval.
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          }
        } catch { /* ignore malformed messages */ }
      };

      es.onerror = () => {
        es?.close();
        es = null;
        // Reconnect after 5s -- server may have restarted or connection dropped
        reconnectTimer = setTimeout(connect, 5_000);
      };
    }

    connect();

    return () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [queryClient]);
}
