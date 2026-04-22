import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ApiResponse, ConsoleSessionListResponse, ConsoleSessionDetail, ConsoleNodeDetail, ConsoleWorktreeListResponse, ConsoleWorkflowListResponse, ConsoleWorkflowDetail, PerfToolCallsResponse, TriggerListResponse, AutoDispatchRequest, AutoDispatchResponse, DiffSummaryResponse } from './types';
import { mapPerfQueryToResult } from './perf-state';

export type { DiffSummaryResponse };

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

/**
 * On-demand hook for fetching git diff statistics for a session.
 *
 * WHY enabled=false by default: the diff-summary endpoint runs a git subprocess
 * and must never be called automatically on page load. Users must explicitly click
 * 'Load diff' to trigger the fetch. Callers call `query.refetch()` in the click handler.
 *
 * enabled param: passed by the caller to control whether refetch is allowed.
 * Prevents the query from firing until explicitly requested.
 */
export function useDiffSummary(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['diff-summary', sessionId],
    queryFn: () => fetchApi<DiffSummaryResponse>(`/api/v2/sessions/${sessionId}/diff-summary`),
    enabled,
    staleTime: Infinity,   // diff results don't change -- SHAs are fixed
    refetchInterval: false, // never auto-refetch
    refetchOnWindowFocus: false,
    retry: false,           // don't retry on error -- user can click again if needed
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

  const retry = () => void query.refetch();
  return mapPerfQueryToResult(query, retry);
}

/**
 * Returns true when the server is running with WORKRAIL_DEV=1, false otherwise.
 * Fetches once at app startup (staleTime: Infinity) -- only I have this flag on.
 * Returns null while the initial check is in flight.
 */
export function useIsDevMode(): boolean | null {
  const query = useQuery({
    queryKey: ['perf', 'dev-mode-check'],
    queryFn: async () => {
      try {
        const data = await fetchApi<PerfToolCallsResponse>('/api/v2/perf/tool-calls?limit=1');
        return data.devMode === true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          return false;
        }
        throw err;
      }
    },
    staleTime: Infinity,
    refetchInterval: false,
    retry: false,
  });

  if (query.isLoading) return null;
  if (query.isError) return false;
  return query.data ?? false;
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
 * Fetches the list of triggers currently loaded by the trigger system.
 * Returns an empty list when the trigger system is disabled (503).
 */
export function useTriggerList() {
  return useQuery({
    queryKey: ['triggers'],
    queryFn: async () => {
      try {
        return await fetchApi<TriggerListResponse>('/api/v2/triggers');
      } catch (err) {
        if (err instanceof HttpError && err.status === 503) {
          // Trigger system not enabled -- return empty list rather than error state
          return { triggers: [] } satisfies TriggerListResponse;
        }
        throw err;
      }
    },
    staleTime: 30_000,
    refetchInterval: 60_000, // triggers don't change often
  });
}

/**
 * Dispatch a workflow run autonomously.
 * Returns the response or throws on HTTP/network error.
 */
export async function dispatchWorkflow(req: AutoDispatchRequest): Promise<AutoDispatchResponse> {
  const res = await fetch('/api/v2/auto/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new HttpError(res.status, json.error ?? res.statusText);
  }
  const json: ApiResponse<AutoDispatchResponse> = await res.json();
  if (!json.success || !json.data) throw new Error(json.error ?? 'Dispatch failed');
  return json.data;
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
          } else if (msg.type === 'worktrees-updated') {
            // Background enrichment completed -- refetch worktrees to get git badge data.
            void queryClient.invalidateQueries({ queryKey: ['worktrees'] });
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
