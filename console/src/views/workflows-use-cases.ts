/**
 * Pure use-case functions for the Workflows catalog view.
 *
 * No React imports. All functions are deterministic: same inputs always
 * produce the same output. These are the only place business logic lives
 * for the Workflows catalog -- keep them here, not in hooks or components.
 *
 * The caller is responsible for filtering out 'routines' workflows before
 * passing data to these functions. The repository layer handles that filter.
 */
import type { ConsoleWorkflowSummary } from '../api/types';
import { CATALOG_TAGS } from '../config/tags';

// ---------------------------------------------------------------------------
// Source info
// ---------------------------------------------------------------------------

export interface WorkflowSourceOption {
  readonly id: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

/**
 * Returns the sorted, unique list of non-routines tags present in the workflow list.
 *
 * Follows CATALOG_TAGS order for known tags; unknown tags appear sorted alphabetically
 * after the known ones.
 */
export function getAvailableTags(workflows: readonly ConsoleWorkflowSummary[]): readonly string[] {
  const present = new Set<string>();
  for (const w of workflows) {
    for (const t of w.tags) {
      if (t !== 'routines') present.add(t);
    }
  }
  const knownOrdered = CATALOG_TAGS.map((t) => t.id).filter((id) => present.has(id));
  const unknown = [...present].filter((id) => !CATALOG_TAGS.some((t) => t.id === id)).sort();
  return [...knownOrdered, ...unknown];
}

/**
 * Returns the unique source options derived from the workflow list.
 * Each source is identified by its kind (id) and displayName.
 * Order is stable: first-seen order from the list.
 */
export function getAvailableSources(
  workflows: readonly ConsoleWorkflowSummary[],
): readonly WorkflowSourceOption[] {
  const seen = new Map<string, WorkflowSourceOption>();
  for (const w of workflows) {
    if (!seen.has(w.source.kind)) {
      seen.set(w.source.kind, { id: w.source.kind, displayName: w.source.displayName });
    }
  }
  return [...seen.values()];
}

/**
 * Filters workflows by tag and source.
 *
 * - tag === null: no tag filter applied
 * - tag === '__other__': include workflows with no recognized non-routines catalog tag
 * - tag === someId: include workflows with that tag
 * - source === null: no source filter applied
 * - source === displayName: include workflows from that source
 */
export function filterWorkflows(
  workflows: readonly ConsoleWorkflowSummary[],
  tag: string | null,
  source: string | null,
): readonly ConsoleWorkflowSummary[] {
  const knownTagIds = new Set(CATALOG_TAGS.map((t) => t.id));

  let filtered = workflows;

  if (tag !== null) {
    if (tag === '__other__') {
      filtered = filtered.filter((w) => !w.tags.some((t) => t !== 'routines' && knownTagIds.has(t)));
    } else {
      filtered = filtered.filter((w) => w.tags.includes(tag));
    }
  }

  if (source !== null) {
    filtered = filtered.filter((w) => w.source.displayName === source);
  }

  return filtered;
}

/**
 * Flattens the filtered workflow list into a single ordered array matching
 * the visual card order for keyboard navigation.
 *
 * When a tag is selected, the list is already flat.
 * When showing all tags, workflows are ordered by CATALOG_TAGS group order to
 * match the grouped rendering in the view.
 */
export function flattenWorkflows(
  filtered: readonly ConsoleWorkflowSummary[],
  selectedTag: string | null,
): readonly ConsoleWorkflowSummary[] {
  if (selectedTag !== null) return filtered;

  const knownTagIds = new Set(CATALOG_TAGS.map((t) => t.id));
  const buckets = new Map<string, ConsoleWorkflowSummary[]>();
  const other: ConsoleWorkflowSummary[] = [];

  for (const w of filtered) {
    const firstKnownTag = w.tags.find((t) => t !== 'routines' && knownTagIds.has(t));
    if (firstKnownTag) {
      const bucket = buckets.get(firstKnownTag) ?? [];
      bucket.push(w);
      buckets.set(firstKnownTag, bucket);
    } else {
      other.push(w);
    }
  }

  const result: ConsoleWorkflowSummary[] = [];
  for (const { id } of CATALOG_TAGS) {
    const bucket = buckets.get(id);
    if (bucket) result.push(...bucket);
  }
  result.push(...other);

  return result;
}
