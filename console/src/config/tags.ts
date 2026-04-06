// Shared workflow tag catalog.
// Routines are excluded from user-facing surfaces -- they are implementation
// building blocks for workflow authors, not task workflows for end users.

export interface TagDefinition {
  readonly id: string;
  readonly label: string;
}

export const CATALOG_TAGS: readonly TagDefinition[] = [
  { id: 'coding',        label: 'Coding' },
  { id: 'review_audit',  label: 'Review & Audit' },
  { id: 'investigation', label: 'Investigation' },
  { id: 'design',        label: 'Design' },
  { id: 'documentation', label: 'Documentation' },
  { id: 'tickets',       label: 'Tickets' },
  { id: 'learning',      label: 'Learning' },
  { id: 'authoring',     label: 'Workflow Authoring' },
];

export const TAG_DISPLAY: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG_TAGS.map((t) => [t.id, t.label]),
);
