# Dashboard Quick Start Guide

## Overview

This guide will help you create a workflow that produces beautiful, auto-generated dashboards with minimal effort. The Generic Dashboard automatically renders your session data based on its structure—no custom UI code required!

## 5-Minute Quick Start

### 1. Basic Session Data

The simplest dashboard-enabled workflow just needs a `dashboard` object:

```json
{
  "dashboard": {
    "title": "My Workflow",
    "subtitle": "Processing...",
    "status": "in_progress",
    "progress": 50
  }
}
```

**Result:** A beautiful hero section with title, status badge, and progress ring.

### 2. Add Your Data

Just add any fields to your session data:

```json
{
  "dashboard": { ... },
  "summary": {
    "description": "This is a summary",
    "confidence": 8.5
  },
  "findings": [
    { "item": "Finding 1", "severity": "high" },
    { "item": "Finding 2", "severity": "medium" }
  ]
}
```

**Result:** Automatic sections with appropriate components based on data patterns!

### 3. Customize Layout (Optional)

Add `_meta` for control over appearance:

```json
{
  "dashboard": {
    "title": "My Workflow",
    "_meta": {
      "order": ["summary", "findings"],
      "collapsible": { "findings": true }
    }
  }
}
```

**That's it!** Your workflow now has a professional dashboard.

## Understanding Auto-Recognition

The dashboard automatically recognizes patterns in your data:

### Arrays with `status`
```json
"tasks": [
  { "task": "Review code", "status": "complete" },
  { "task": "Write tests", "status": "in_progress" }
]
```
→ **Grouped List** (grouped by status)

### Arrays with `severity`
```json
"issues": [
  { "issue": "Critical bug", "severity": "high" },
  { "issue": "Minor typo", "severity": "low" }
]
```
→ **Severity List** (color-coded by severity)

### Arrays with `priority`
```json
"recommendations": [
  { "description": "Fix ASAP", "priority": 9 },
  { "description": "Nice to have", "priority": 3 }
]
```
→ **Priority List** (sorted by priority)

### Arrays with `timestamp`
```json
"timeline": [
  { "event": "Started", "timestamp": "2025-10-11T10:00:00Z" },
  { "event": "Finished", "timestamp": "2025-10-11T11:00:00Z" }
]
```
→ **Timeline** (chronological with visual dots)

### Objects with `complete`
```json
"phases": {
  "phase-0": { "name": "Setup", "complete": true },
  "phase-1": { "name": "Execution", "complete": false }
}
```
→ **Phases List** (collapsible with status indicators)

### Objects with high `confidence`
```json
"conclusion": {
  "title": "Root Cause Found",
  "description": "...",
  "confidence": 9.2
}
```
→ **Highlight Card** (emphasized styling)

### Numbers (0-100)
```json
"score": 85
```
→ **Progress Bar** with color-coded ring

### Booleans
```json
"testsPassed": true
```
→ **Checkbox** (checked/unchecked)

### URLs
```json
"documentation": "https://docs.example.com/guide"
```
→ **Link** (clickable)

### File Paths
```json
"file": "/src/components/Button.tsx"
```
→ **Path Display** (monospace formatting)

## Common Patterns

### Bug Investigation Dashboard

```json
{
  "dashboard": {
    "title": "Bug Investigation: AUTH-1234",
    "subtitle": "Token Refresh Issue",
    "status": "in_progress",
    "progress": 65,
    "confidence": 7.5,
    "_meta": {
      "order": ["bugSummary", "rootCause", "fix", "hypotheses", "timeline"],
      "collapsible": { "timeline": true, "hypotheses": true }
    }
  },
  "bugSummary": {
    "description": "Users unable to refresh auth tokens",
    "severity": "high",
    "affectedUsers": "~1000"
  },
  "rootCause": {
    "description": "Token expiry using server time instead of UTC",
    "confidence": 9.5,
    "file": "/src/auth/token-manager.ts",
    "line": 145
  },
  "fix": {
    "description": "Update to use UTC timestamps",
    "reasoning": "Ensures consistent behavior across timezones"
  },
  "hypotheses": [
    {
      "hypothesis": "Timezone bug",
      "status": "confirmed",
      "confidence": 9.5
    },
    {
      "hypothesis": "Database issue",
      "status": "rejected",
      "confidence": 2.0
    }
  ],
  "timeline": [
    {
      "timestamp": "2025-10-11T10:00:00Z",
      "event": "Investigation started"
    },
    {
      "timestamp": "2025-10-11T11:30:00Z",
      "event": "Root cause identified"
    }
  ]
}
```

### Code Review Dashboard

```json
{
  "dashboard": {
    "title": "Code Review: PR-456",
    "subtitle": "Feature: User Profile Updates",
    "status": "in_progress",
    "progress": 40,
    "_meta": {
      "order": ["summary", "findings", "recommendations"],
      "icons": {
        "summary": "file-text",
        "findings": "alert-circle",
        "recommendations": "star"
      }
    }
  },
  "summary": {
    "filesChanged": 8,
    "linesAdded": 234,
    "linesRemoved": 67,
    "author": "jane@example.com",
    "reviewers": ["john@example.com", "alice@example.com"]
  },
  "findings": [
    {
      "finding": "Missing error handling in updateProfile()",
      "severity": "high",
      "file": "/src/profile.ts",
      "line": 45
    },
    {
      "finding": "Consider using const instead of let",
      "severity": "low",
      "file": "/src/utils.ts",
      "line": 12
    }
  ],
  "recommendations": [
    {
      "priority": 9,
      "description": "Add try-catch blocks",
      "reasoning": "Prevents unhandled exceptions"
    },
    {
      "priority": 5,
      "description": "Add JSDoc comments",
      "reasoning": "Improves code documentation"
    }
  ]
}
```

### Test Results Dashboard

```json
{
  "dashboard": {
    "title": "Test Run: Suite #1234",
    "subtitle": "Full Integration Tests",
    "status": "complete",
    "progress": 100,
    "_meta": {
      "order": ["summary", "results", "failures"],
      "collapsible": { "failures": true }
    }
  },
  "summary": {
    "totalTests": 156,
    "passed": 148,
    "failed": 8,
    "duration": "2m 34s",
    "coverage": "87%"
  },
  "results": [
    { "suite": "Auth", "passed": 45, "failed": 0, "status": "complete" },
    { "suite": "API", "passed": 67, "failed": 3, "status": "complete" },
    { "suite": "UI", "passed": 36, "failed": 5, "status": "complete" }
  ],
  "failures": [
    {
      "test": "should handle invalid tokens",
      "error": "Expected 401, got 500",
      "file": "/tests/auth.test.ts",
      "line": 234
    }
  ]
}
```

## Best Practices

### 1. Start with Dashboard Object

Always include a `dashboard` object with at least:
```json
{
  "dashboard": {
    "title": "Clear, descriptive title",
    "status": "in_progress" | "complete" | "error",
    "progress": 0-100  // Optional but recommended
  }
}
```

### 2. Use Semantic Field Names

Choose field names that describe the content:
- ✅ `bugSummary`, `rootCause`, `timeline`
- ❌ `data1`, `output`, `result`

### 3. Structure Data by Type

Group related data:
```json
{
  "findings": [
    { "finding": "...", "severity": "high" }
  ],
  "recommendations": [
    { "description": "...", "priority": 8 }
  ]
}
```

### 4. Include Confidence Scores

For AI-generated insights:
```json
{
  "conclusion": {
    "description": "...",
    "confidence": 8.5  // 0-10 scale
  }
}
```

### 5. Add Timestamps for Timelines

```json
{
  "timeline": [
    {
      "timestamp": "2025-10-11T10:00:00Z",  // ISO 8601
      "event": "Started investigation"
    }
  ]
}
```

### 6. Use Status for Grouped Lists

```json
{
  "tasks": [
    { "task": "...", "status": "complete" | "in_progress" | "pending" }
  ]
}
```

### 7. Organize with _meta

For complex dashboards:
```json
{
  "dashboard": {
    "_meta": {
      "order": ["summary", "details", "timeline"],
      "hidden": ["_internal"],
      "collapsible": { "timeline": true }
    }
  }
}
```

## Progressive Enhancement

Start simple, add complexity as needed:

### Level 1: Basic Hero
```json
{
  "dashboard": {
    "title": "My Workflow",
    "status": "in_progress"
  }
}
```

### Level 2: Add Progress
```json
{
  "dashboard": {
    "title": "My Workflow",
    "status": "in_progress",
    "progress": 50,
    "confidence": 7.5
  }
}
```

### Level 3: Add Data Sections
```json
{
  "dashboard": { ... },
  "summary": { ... },
  "findings": [ ... ]
}
```

### Level 4: Customize Layout
```json
{
  "dashboard": {
    ...
    "_meta": {
      "order": [...],
      "collapsible": { ... }
    }
  }
}
```

## Workflow Integration

### Using MCP Tools

From your workflow instructions:

```markdown
Use the workrail_update_session tool to update the dashboard:

```json
{
  "tool": "workrail_update_session",
  "parameters": {
    "workflowId": "my-workflow",
    "sessionId": "SESSION-001",
    "updates": {
      "dashboard": {
        "title": "Investigation: SESSION-001",
        "status": "in_progress",
        "progress": 30
      },
      "findings": [...]
    }
  }
}
```

### Incremental Updates

Update the dashboard as your workflow progresses:

**Step 1: Initialize**
```json
{
  "dashboard": {
    "title": "Bug Investigation",
    "status": "in_progress",
    "progress": 0
  }
}
```

**Step 2: Add Findings**
```json
{
  "dashboard.progress": 30,
  "findings": [{ "finding": "...", "severity": "high" }]
}
```

**Step 3: Add Conclusion**
```json
{
  "dashboard.progress": 100,
  "dashboard.status": "complete",
  "conclusion": { "description": "...", "confidence": 9.0 }
}
```

## Troubleshooting

### Section Not Rendering

**Problem:** Field appears in data but not on dashboard.

**Solutions:**
1. Check if field is in `_meta.hidden`
2. Ensure field value is not null/undefined
3. Check browser console for errors

### Wrong Component Type

**Problem:** Data rendered with unexpected component.

**Solutions:**
1. Add status field for grouped lists: `{ "item": "...", "status": "..." }`
2. Add severity field for severity lists: `{ "item": "...", "severity": "high" }`
3. Add timestamp for timeline: `{ "event": "...", "timestamp": "..." }`

### Poor Layout

**Problem:** Sections in wrong order or too cluttered.

**Solutions:**
1. Use `_meta.order` to control section sequence
2. Use `_meta.collapsible` for long sections
3. Use `_meta.hidden` to hide internal fields

## Next Steps

1. **Read the Configuration Guide**: [dashboard-configuration.md](./dashboard-configuration.md)
2. **Use the Helper Class**: See DashboardWriter below
3. **Check Examples**: Browse `sessions/` for real examples
4. **Test Your Dashboard**: Use the test session pattern

## DashboardWriter Helper

For complex dashboards, use the DashboardWriter helper (see [dashboard-writer.md](./dashboard-writer.md)):

```javascript
import { DashboardWriter } from './dashboard-writer.js';

const dashboard = new DashboardWriter('my-workflow', 'SESSION-001');

dashboard
  .setTitle('Bug Investigation')
  .setStatus('in_progress')
  .setProgress(30)
  .addSection('findings', [
    { finding: '...', severity: 'high' }
  ])
  .setOrder(['summary', 'findings', 'timeline'])
  .makeCollapsible('timeline')
  .save();
```

## Resources

- **Configuration Guide**: [dashboard-configuration.md](./dashboard-configuration.md)
- **Pattern Reference**: See "Understanding Auto-Recognition" above
- **Examples**: Browse `sessions/` directory
- **API Reference**: [mcp-integration-guide.md](./mcp-integration-guide.md)

## Support

If you encounter issues:
1. Check browser console for errors
2. Validate your JSON structure
3. Review pattern recognition rules
4. See [TESTING_GUIDE.md](../TESTING_GUIDE.md) for debugging tips






