# DashboardWriter API Reference

## Overview

`DashboardWriter` is a TypeScript utility class that provides a fluent API for building dashboard-ready session data. It simplifies creating well-structured data with proper typing and validation.

## Installation

```typescript
import { DashboardWriter } from '@/utils/DashboardWriter';
```

## Basic Usage

```typescript
const dashboard = new DashboardWriter('workflow-id', 'session-id');

dashboard
  .setTitle('My Investigation')
  .setStatus('in_progress')
  .setProgress(50)
  .addSection('summary', { description: 'Working on it...' })
  .setOrder(['summary', 'timeline'])
  .makeCollapsible('timeline');

// Get the data
const data = dashboard.getData();

// Or convert to JSON
const json = dashboard.toJSON();
```

## Constructor

### `new DashboardWriter(workflowId, sessionId)`

Creates a new DashboardWriter instance.

**Parameters:**
- `workflowId` (string): The workflow identifier
- `sessionId` (string): The session identifier

**Example:**
```typescript
const dashboard = new DashboardWriter('bug-investigation', 'BUG-123');
```

## Dashboard Configuration Methods

### `setTitle(title: string): this`

Sets the dashboard title (displayed in hero section).

```typescript
dashboard.setTitle('Bug Investigation: AUTH-1234');
```

### `setSubtitle(subtitle: string): this`

Sets the dashboard subtitle.

```typescript
dashboard.setSubtitle('Token Refresh Issue');
```

### `setStatus(status): this`

Sets the workflow status.

**Status values:**
- `'pending'` - Not started
- `'in_progress'` - Currently running
- `'complete'` - Finished successfully
- `'error'` - Failed with error
- `'cancelled'` - Cancelled by user

```typescript
dashboard.setStatus('in_progress');
```

### `setProgress(progress: number): this`

Sets progress percentage (0-100). Automatically clamped to valid range.

```typescript
dashboard.setProgress(65);  // 65%
```

### `setConfidence(confidence: number): this`

Sets confidence score (0-10). Automatically clamped to valid range.

```typescript
dashboard.setConfidence(8.5);  // 8.5/10
```

### `setCurrentPhase(phase: string): this`

Sets the current phase name.

```typescript
dashboard.setCurrentPhase('Root Cause Analysis');
```

## Meta Configuration Methods

### `setOrder(order: string[]): this`

Sets the order of sections on the dashboard.

```typescript
dashboard.setOrder(['summary', 'findings', 'timeline', 'recommendations']);
```

### `addToOrder(field: string): this`

Adds a field to the end of the order array.

```typescript
dashboard
  .addToOrder('summary')
  .addToOrder('findings')
  .addToOrder('timeline');
```

### `hide(...fields: string[]): this`

Hides fields from the dashboard.

```typescript
dashboard.hide('_internal', 'debugData', 'tempState');
```

### `setIcon(field: string, icon: string): this`

Sets a custom icon for a section. Uses [Lucide icons](https://lucide.dev/icons).

```typescript
dashboard
  .setIcon('summary', 'file-text')
  .setIcon('findings', 'alert-circle')
  .setIcon('timeline', 'clock');
```

### `makeCollapsible(field: string, collapsible = true): this`

Makes a section collapsible.

```typescript
dashboard
  .makeCollapsible('timeline')      // Collapsible
  .makeCollapsible('summary', false);  // Not collapsible
```

## Data Section Methods

### `addSection(name: string, data: any): this`

Adds or replaces a section.

```typescript
dashboard.addSection('summary', {
  description: 'Investigation in progress',
  severity: 'high',
  affectedUsers: 1000
});
```

### `updateSection(name: string, updates: any): this`

Updates an existing section (shallow merge).

```typescript
dashboard.updateSection('summary', {
  severity: 'critical',  // Updated
  confidence: 9.0        // Added
  // description and affectedUsers remain unchanged
});
```

### `removeSection(name: string): this`

Removes a section.

```typescript
dashboard.removeSection('tempData');
```

## Specialized Section Builders

### Timeline

#### `addTimeline(event): this`

Adds an event to the timeline.

**Event structure:**
```typescript
{
  event: string;           // Event description (required)
  timestamp?: string;      // ISO 8601 timestamp (auto-generated if omitted)
  details?: string;        // Additional details
  [key: string]: any;      // Custom fields
}
```

**Example:**
```typescript
dashboard
  .addTimeline({
    event: 'Investigation started',
    details: 'Analyzing user reports'
  })
  .addTimeline({
    event: 'Root cause identified',
    timestamp: '2025-10-11T15:30:00Z',
    details: 'Found timezone bug in token refresh'
  });
```

### Hypotheses

#### `addHypothesis(hypothesis): this`

Adds a hypothesis to test.

**Hypothesis structure:**
```typescript
{
  hypothesis: string;      // Hypothesis description (required)
  status: 'active' | 'testing' | 'confirmed' | 'partial' | 'rejected' | 'cancelled';
  confidence?: number;     // 0-10 scale
  reasoning?: string;      // Why you believe this
  [key: string]: any;      // Custom fields
}
```

**Example:**
```typescript
dashboard
  .addHypothesis({
    hypothesis: 'Token expiry check using server time',
    status: 'confirmed',
    confidence: 9.5,
    reasoning: 'Log analysis shows time discrepancies'
  })
  .addHypothesis({
    hypothesis: 'Database connection pool exhaustion',
    status: 'rejected',
    confidence: 2.0,
    reasoning: 'Connection metrics show normal levels'
  });
```

### Recommendations

#### `addRecommendation(recommendation): this`

Adds a recommendation.

**Recommendation structure:**
```typescript
{
  description: string;     // Recommendation (required)
  priority: number;        // Priority score (required)
  reasoning?: string;      // Why this is recommended
  effort?: string;         // Effort estimate
  status?: string;         // Implementation status
  [key: string]: any;      // Custom fields
}
```

**Example:**
```typescript
dashboard
  .addRecommendation({
    description: 'Implement UTC-based token expiry',
    priority: 9,
    reasoning: 'Prevents timezone-related bugs',
    effort: '2 hours'
  })
  .addRecommendation({
    description: 'Add integration tests',
    priority: 7,
    reasoning: 'Catch similar issues in future',
    effort: '4 hours',
    status: 'planned'
  });
```

### Findings

#### `addFinding(finding): this`

Adds a finding or issue.

**Finding structure:**
```typescript
{
  finding?: string;        // Finding description
  description?: string;    // Alternative to 'finding'
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';  // Required
  file?: string;           // File path
  line?: number;           // Line number
  [key: string]: any;      // Custom fields
}
```

**Example:**
```typescript
dashboard
  .addFinding({
    finding: 'Missing error handling in updateProfile()',
    severity: 'high',
    file: '/src/profile.ts',
    line: 45
  })
  .addFinding({
    description: 'Unused import statement',
    severity: 'low',
    file: '/src/utils.ts',
    line: 3
  });
```

### Phases

#### `addPhase(phaseId: string, phase): this`

Adds or updates a phase.

**Phase structure:**
```typescript
{
  name: string;            // Phase name (required)
  complete: boolean;       // Completion status (required)
  summary?: string;        // Phase summary
  details?: any;           // Additional details
  [key: string]: any;      // Custom fields
}
```

**Example:**
```typescript
dashboard
  .addPhase('phase-0', {
    name: 'Investigation',
    complete: true,
    summary: 'Analyzed logs and identified time sync issue'
  })
  .addPhase('phase-1', {
    name: 'Root Cause Analysis',
    complete: false,
    summary: 'In progress...'
  });
```

#### `completePhase(phaseId: string): this`

Marks a phase as complete.

```typescript
dashboard.completePhase('phase-1');
```

## Utility Methods

### `getData(): SessionData`

Returns a deep copy of the current session data.

```typescript
const data = dashboard.getData();
console.log(data);
```

### `toJSON(): string`

Returns a formatted JSON string.

```typescript
const json = dashboard.toJSON();
console.log(json);
```

### `toUpdates(): Record<string, any>`

Returns an object suitable for incremental updates.

```typescript
const updates = dashboard.toUpdates();
// Use with workrail_update_session
```

### `async save(): Promise<void>`

Saves to session (requires MCP implementation).

**Note:** This is a placeholder method. You need to implement it based on your MCP setup.

```typescript
// Example implementation:
class MyDashboardWriter extends DashboardWriter {
  async save() {
    await mcpClient.updateSession({
      workflowId: this.workflowId,
      sessionId: this.sessionId,
      updates: this.toUpdates()
    });
  }
}
```

## Static Factory Methods

### `DashboardWriter.bugInvestigation(sessionId): DashboardWriter`

Creates a pre-configured DashboardWriter for bug investigation workflows.

**Pre-configured with:**
- Order: bugSummary → rootCause → fix → hypotheses → timeline → recommendations
- Icons for all sections
- Timeline and hypotheses collapsible

```typescript
const dashboard = DashboardWriter.bugInvestigation('BUG-123')
  .setTitle('Auth Token Issue')
  .setStatus('in_progress')
  .addSection('bugSummary', { ... })
  .addHypothesis({ ... });
```

### `DashboardWriter.codeReview(sessionId): DashboardWriter`

Creates a pre-configured DashboardWriter for code review workflows.

**Pre-configured with:**
- Order: summary → findings → recommendations
- Icons for all sections
- Findings collapsible

```typescript
const dashboard = DashboardWriter.codeReview('PR-456')
  .setTitle('Review: Profile Updates')
  .addFinding({ ... })
  .addRecommendation({ ... });
```

### `DashboardWriter.testResults(sessionId): DashboardWriter`

Creates a pre-configured DashboardWriter for test result workflows.

**Pre-configured with:**
- Order: summary → results → failures
- Icons for all sections
- Failures collapsible

```typescript
const dashboard = DashboardWriter.testResults('TEST-789')
  .setTitle('Integration Tests')
  .setProgress(100)
  .addSection('summary', { totalTests: 156, passed: 148, failed: 8 });
```

## Complete Example

```typescript
import { DashboardWriter } from '@/utils/DashboardWriter';

// Create dashboard for bug investigation
const dashboard = DashboardWriter.bugInvestigation('AUTH-1234');

// Configure dashboard
dashboard
  .setTitle('Bug Investigation: AUTH-1234')
  .setSubtitle('Token Refresh Issue')
  .setStatus('in_progress')
  .setProgress(65)
  .setConfidence(7.5)
  .setCurrentPhase('Root Cause Analysis');

// Add bug summary
dashboard.addSection('bugSummary', {
  description: 'Users unable to refresh auth tokens',
  severity: 'high',
  affectedUsers: '~1000',
  reportedAt: '2025-10-11T09:00:00Z'
});

// Add hypotheses
dashboard
  .addHypothesis({
    hypothesis: 'Token expiry check using server time instead of UTC',
    status: 'confirmed',
    confidence: 9.5,
    reasoning: 'Log analysis shows time discrepancies matching user reports'
  })
  .addHypothesis({
    hypothesis: 'Database connection pool exhaustion',
    status: 'rejected',
    confidence: 2.0,
    reasoning: 'Connection metrics show normal levels'
  });

// Add timeline events
dashboard
  .addTimeline({ event: 'Investigation started', details: 'User reports analyzed' })
  .addTimeline({ event: 'Identified timezone pattern', details: 'Errors correlate with timezone offsets' })
  .addTimeline({ event: 'Root cause confirmed', details: 'Token expiry using local server time' });

// Add recommendations
dashboard
  .addRecommendation({
    description: 'Implement UTC-based token expiry',
    priority: 9,
    reasoning: 'Prevents timezone-related bugs',
    effort: '2 hours'
  })
  .addRecommendation({
    description: 'Add integration tests for token refresh',
    priority: 7,
    reasoning: 'Catch similar issues in the future',
    effort: '4 hours'
  });

// Get the data
const data = dashboard.getData();
console.log(JSON.stringify(data, null, 2));

// Or save directly (if implemented)
// await dashboard.save();
```

## Best Practices

### 1. Use Factory Methods for Common Workflows

```typescript
// ✅ Good
const dashboard = DashboardWriter.bugInvestigation('BUG-123');

// ❌ Less ideal
const dashboard = new DashboardWriter('bug-investigation', 'BUG-123')
  .setOrder([...])
  .setIcon(...);
```

### 2. Chain Methods for Readability

```typescript
// ✅ Good
dashboard
  .setTitle('Investigation')
  .setStatus('in_progress')
  .setProgress(50);

// ❌ Less readable
dashboard.setTitle('Investigation');
dashboard.setStatus('in_progress');
dashboard.setProgress(50);
```

### 3. Use Specialized Builders

```typescript
// ✅ Good - auto-adds timestamp
dashboard.addTimeline({ event: 'Started' });

// ❌ More work
dashboard.addSection('timeline', [
  ...dashboard.getData().timeline || [],
  { event: 'Started', timestamp: new Date().toISOString() }
]);
```

### 4. Validate Data Early

```typescript
try {
  dashboard.completePhase('phase-1');
} catch (error) {
  console.error('Phase does not exist:', error);
}
```

### 5. Use TypeScript for Type Safety

```typescript
import { DashboardWriter, DashboardMeta, DashboardData } from '@/utils/DashboardWriter';

// TypeScript will catch errors
dashboard.setStatus('invalid');  // ❌ TypeScript error
dashboard.setStatus('in_progress');  // ✅ Valid
```

## Migration from Manual JSON

**Before (Manual JSON):**
```typescript
const updates = {
  dashboard: {
    title: 'Investigation',
    status: 'in_progress',
    progress: 50,
    _meta: {
      order: ['summary', 'timeline'],
      collapsible: { timeline: true }
    }
  },
  summary: { ... },
  timeline: [
    { event: 'Started', timestamp: new Date().toISOString() }
  ]
};
```

**After (DashboardWriter):**
```typescript
const dashboard = new DashboardWriter('workflow', 'session')
  .setTitle('Investigation')
  .setStatus('in_progress')
  .setProgress(50)
  .setOrder(['summary', 'timeline'])
  .makeCollapsible('timeline')
  .addSection('summary', { ... })
  .addTimeline({ event: 'Started' });

const updates = dashboard.toUpdates();
```

## See Also

- [Dashboard Quick Start](./dashboard-quickstart.md)
- [Dashboard Configuration Guide](./dashboard-configuration.md)
- [MCP Integration Guide](../MCP_INTEGRATION_GUIDE.md)






