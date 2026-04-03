import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ApiResponse, ConsoleSessionListResponse, ConsoleSessionDetail, ConsoleNodeDetail, ConsoleWorktreeListResponse } from './types';

async function fetchApi<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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

/**
 * Subscribes to the workspace SSE stream and invalidates sessions + worktrees
 * queries immediately when the server detects a change. This gives near-instant
 * UI updates when a workflow advances, a status changes, or a new session starts.
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
            // Invalidate both queries so they refetch immediately
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
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
