import { useQuery } from '@tanstack/react-query';
import type { ApiResponse, ConsoleSessionListResponse, ConsoleSessionDetail, ConsoleNodeDetail } from './types';

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
