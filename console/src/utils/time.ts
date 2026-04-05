/**
 * Shared time formatting utilities for the WorkRail Console.
 */

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * Returns strings like "just now", "5m ago", "3h ago", "2d ago", "1w ago", "3mo ago".
 * Negative deltas (future timestamps) are treated as "just now".
 */
export function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
