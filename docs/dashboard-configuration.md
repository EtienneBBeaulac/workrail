# Dashboard Configuration Guide

## Overview

The Generic Dashboard supports configuration via `dashboard._meta`, allowing workflow authors to control:
- **Section Order**: Specify which sections appear first
- **Hidden Fields**: Hide specific fields from the dashboard
- **Custom Icons**: Assign custom icons to sections
- **Collapsible Sections**: Make sections expandable/collapsible

## Configuration Structure

```json
{
  "dashboard": {
    "title": "My Workflow Dashboard",
    "subtitle": "Running investigation...",
    "status": "in_progress",
    "progress": 45,
    "_meta": {
      "order": ["phases", "hypotheses", "timeline", "recommendations"],
      "hidden": ["_internal", "tempData"],
      "icons": {
        "hypotheses": "lightbulb",
        "timeline": "clock",
        "recommendations": "star"
      },
      "collapsible": {
        "timeline": true,
        "recommendations": true
      }
    }
  },
  "phases": { ... },
  "hypotheses": [ ... ],
  "timeline": [ ... ],
  "recommendations": [ ... ]
}
```

## Configuration Options

### `order` (Array of strings)

Specify the order in which sections should appear on the dashboard.

**Example:**
```json
"_meta": {
  "order": ["summary", "phases", "results", "timeline"]
}
```

**Behavior:**
- Sections listed in `order` appear first, in the specified sequence
- Remaining sections appear after, sorted alphabetically
- The `dashboard` field is always rendered first (for hero section)
- Non-existent fields in `order` are ignored

### `hidden` (Array of strings)

Hide specific fields from being rendered on the dashboard.

**Example:**
```json
"_meta": {
  "hidden": ["_internal", "debug", "tempData"]
}
```

**Use Cases:**
- Hide internal/debug fields
- Hide work-in-progress data
- Hide sensitive information
- Hide fields intended only for MCP processing

### `icons` (Object mapping field name to icon name)

Assign custom Lucide icons to sections.

**Example:**
```json
"_meta": {
  "icons": {
    "hypotheses": "lightbulb",
    "bugSummary": "bug",
    "timeline": "clock",
    "recommendations": "star",
    "rootCause": "alert-circle"
  }
}
```

**Available Icons:**
See [Lucide Icons](https://lucide.dev/icons) for the full list. Common options:
- `lightbulb` - Ideas, hypotheses
- `bug` - Bug information
- `clock` - Timeline, history
- `star` - Recommendations, highlights
- `alert-circle` - Errors, warnings
- `check-circle` - Success, completion
- `layers` - Phases, stages
- `code` - Code-related sections
- `file-text` - Documentation, summaries

### `collapsible` (Object mapping field name to boolean)

Make sections expandable/collapsible with a toggle.

**Example:**
```json
"_meta": {
  "collapsible": {
    "timeline": true,
    "recommendations": true,
    "phases": false
  }
}
```

**Features:**
- Click section header to expand/collapse
- State is saved in localStorage (persists across page refreshes)
- Smooth animation on toggle
- Visual indicator (▼ icon rotates when collapsed)

## Complete Example

```json
{
  "dashboard": {
    "title": "Bug Investigation: AUTH-1234",
    "subtitle": "Authentication Token Refresh Issue",
    "status": "in_progress",
    "progress": 65,
    "confidence": 7.5,
    "_meta": {
      "order": [
        "bugSummary",
        "rootCause",
        "fix",
        "phases",
        "hypotheses",
        "timeline",
        "recommendations"
      ],
      "hidden": [
        "_internalState",
        "debugInfo"
      ],
      "icons": {
        "bugSummary": "bug",
        "rootCause": "alert-circle",
        "fix": "wrench",
        "phases": "layers",
        "hypotheses": "lightbulb",
        "timeline": "clock",
        "recommendations": "star"
      },
      "collapsible": {
        "timeline": true,
        "recommendations": true,
        "hypotheses": true
      }
    }
  },
  "bugSummary": {
    "description": "Users unable to refresh auth tokens...",
    "severity": "high",
    "affectedUsers": "~1000"
  },
  "rootCause": {
    "description": "Token expiry check using server time instead of client time",
    "confidence": 9.5,
    "file": "/src/auth/token-manager.ts",
    "line": 145
  },
  "fix": {
    "description": "Update token expiry check to use UTC timestamps",
    "reasoning": "Ensures consistent behavior across timezones"
  },
  "phases": {
    "phase-0": {
      "name": "Investigation",
      "complete": true,
      "summary": "Analyzed logs and identified time sync issue"
    },
    "phase-1": {
      "name": "Root Cause Analysis",
      "complete": true,
      "summary": "Confirmed timezone-related token expiry bug"
    },
    "phase-2": {
      "name": "Solution Design",
      "complete": false,
      "summary": "Designing UTC-based token expiry check"
    }
  },
  "hypotheses": [
    {
      "hypothesis": "Token expiry using local server time",
      "status": "confirmed",
      "confidence": 9.5,
      "reasoning": "Log analysis shows time discrepancies matching user reports"
    },
    {
      "hypothesis": "Database connection pool exhaustion",
      "status": "rejected",
      "reasoning": "Connection metrics show normal levels"
    }
  ],
  "timeline": [
    {
      "timestamp": "2025-10-11T14:30:00Z",
      "event": "Started investigation",
      "details": "User reports analyzed"
    },
    {
      "timestamp": "2025-10-11T15:15:00Z",
      "event": "Identified timezone pattern",
      "details": "Errors correlate with timezone offsets"
    }
  ],
  "recommendations": [
    {
      "priority": 9,
      "description": "Implement UTC-based token expiry",
      "reasoning": "Prevents timezone-related bugs"
    },
    {
      "priority": 7,
      "description": "Add integration tests for token refresh",
      "reasoning": "Catch similar issues in the future"
    }
  ]
}
```

## Best Practices

### 1. **Logical Ordering**
Place the most important information first:
```json
"order": ["summary", "rootCause", "fix", "details"]
```

### 2. **Hide Implementation Details**
Don't clutter the dashboard with internal state:
```json
"hidden": ["_state", "_cache", "debug"]
```

### 3. **Use Semantic Icons**
Choose icons that clearly represent the content:
```json
"icons": {
  "errors": "alert-circle",
  "success": "check-circle",
  "pending": "clock"
}
```

### 4. **Collapse Long Sections**
Make long sections collapsible to keep dashboard scannable:
```json
"collapsible": {
  "timeline": true,      // Often contains many events
  "detailedLogs": true,  // Can be very long
  "stackTraces": true    // Technical details
}
```

### 5. **Progressive Disclosure**
Show summaries first, details in collapsible sections:
- Keep `bugSummary` and `rootCause` visible
- Make `timeline` and `recommendations` collapsible
- Hide raw data in `hidden` fields

## Integration with Workflows

### In Workflow Steps

When your workflow writes dashboard data:

```typescript
// Example workflow step
{
  "id": "update-dashboard",
  "action": "Update dashboard with configuration",
  "instructions": [
    "Use the workrail_update_session tool to update the dashboard",
    "Include dashboard._meta with appropriate configuration:",
    "- order: Place most important sections first",
    "- hidden: Hide any internal/debug fields",
    "- icons: Use semantic icons (bug, lightbulb, clock, etc.)",
    "- collapsible: Make long sections (timeline, logs) collapsible"
  ]
}
```

### Example Tool Call

```json
{
  "tool": "workrail_update_session",
  "parameters": {
    "workflowId": "bug-investigation",
    "sessionId": "AUTH-1234",
    "updates": {
      "dashboard": {
        "title": "Bug Investigation: AUTH-1234",
        "status": "in_progress",
        "progress": 65,
        "_meta": {
          "order": ["bugSummary", "rootCause", "fix", "hypotheses"],
          "hidden": ["_state"],
          "collapsible": { "hypotheses": true }
        }
      },
      "bugSummary": { ... },
      "rootCause": { ... }
    }
  }
}
```

## Troubleshooting

### Section not appearing in specified order
- **Check:** Is the field name in `order` spelled correctly?
- **Check:** Does the field actually exist in your session data?
- **Solution:** Verify field names match exactly (case-sensitive)

### Icon not showing
- **Check:** Is the icon name valid? See [Lucide Icons](https://lucide.dev/icons)
- **Check:** Is Lucide loaded? (Should be automatic in dashboard)
- **Solution:** Try a different icon name or check browser console

### Collapsible not working
- **Check:** Does the section have a `section-header` element?
- **Check:** Is the field name in `collapsible` correct?
- **Solution:** Only top-level fields can be made collapsible

### Hidden field still visible
- **Check:** Is the field name spelled correctly in `hidden`?
- **Check:** Are you hiding a nested field? (Only top-level fields can be hidden)
- **Solution:** Use exact field names from your session data

## Advanced: Dynamic Configuration

You can dynamically generate `_meta` based on workflow state:

```json
{
  "dashboard": {
    "_meta": {
      "order": [
        "summary",
        "${currentPhase}Details",  // Dynamic field based on phase
        "timeline"
      ],
      "hidden": [
        "${debugMode ? '' : 'debugInfo'}"  // Conditional hiding
      ],
      "collapsible": {
        "timeline": ${timelineLength > 10}  // Auto-collapse if long
      }
    }
  }
}
```

**Note:** The above is conceptual. In practice, your workflow logic should compute these values before writing to the session.






