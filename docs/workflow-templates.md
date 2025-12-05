# Workflow Templates

The Template Registry provides pre-built templates for common workflow types, making it easy to get started quickly.

## Quick Start

### Using CLI

```bash
# List available templates
node scripts/create-from-template.js --list

# Create from template
node scripts/create-from-template.js bug-investigation

# This creates: bug-investigation-workflow.json
```

### Using Programmatically

```javascript
import { templateRegistry } from './template-registry.js';

// Create from template
const data = templateRegistry.createFromTemplate('bug-investigation', {
  'dashboard.title': 'Auth Token Bug',
  'bugSummary': 'Users unable to log in'
});

// Use in workflow
workrail.createSession('my-workflow', 'BUG-001', data);
```

## Available Templates

### Bug Investigation

**ID:** `bug-investigation`  
**Category:** Debugging  
**Schema:** bug-investigation

Systematic bug investigation with hypotheses, timeline, and recommendations.

**Fields:**
- `dashboard` - Title, status, progress, confidence
- `bugSummary` - Detailed bug description
- `hypotheses` - Array of hypotheses with status
- `timeline` - Investigation timeline
- `phases` - Investigation phases
- `recommendations` - Suggested fixes

**Example:**
```javascript
{
  dashboard: {
    title: 'Auth Token Expiration Bug',
    status: 'in_progress',
    progress: 45,
    confidence: 7
  },
  bugSummary: 'Users are being logged out unexpectedly',
  hypotheses: [
    {
      description: 'Token expiration time misconfigured',
      status: 'confirmed',
      confidence: 9
    }
  ]
}
```

### Code Review

**ID:** `code-review`  
**Category:** Quality  
**Schema:** code-review

Code review workflow with findings, severities, and approval tracking.

**Fields:**
- `dashboard` - Title, status, progress
- `summary` - Overall review summary
- `changes` - List of changed files
- `findings` - Issues found with severity
- `approved` - Approval status

**Example:**
```javascript
{
  dashboard: {
    title: 'PR #123: Add Authentication',
    status: 'in_progress'
  },
  findings: [
    {
      severity: 'high',
      description: 'SQL injection vulnerability',
      file: 'auth.ts',
      line: 45
    }
  ],
  approved: false
}
```

### Test Results

**ID:** `test-results`  
**Category:** Testing  
**Schema:** test-results

Test execution results with pass/fail tracking and trends.

**Fields:**
- `dashboard` - Title, status, progress
- `summary` - Test counts (total, passed, failed, skipped)
- `tests` - Individual test results
- `testResultsTrend` - Historical trend data

**Example:**
```javascript
{
  dashboard: {
    title: 'E2E Test Run',
    status: 'passed'
  },
  summary: {
    total: 50,
    passed: 48,
    failed: 2,
    skipped: 0
  },
  testResultsTrend: [
    { label: 'Previous', value: 45 },
    { label: 'Current', value: 48 }
  ]
}
```

### Documentation

**ID:** `documentation`  
**Category:** Documentation  

Documentation generation with section tracking and coverage metrics.

**Fields:**
- `dashboard` - Title, status, progress
- `sections` - Documentation sections with status
- `coverage` - Coverage metrics

**Example:**
```javascript
{
  dashboard: {
    title: 'API Documentation',
    progress: 75
  },
  sections: [
    { title: 'Overview', status: 'complete' },
    { title: 'Authentication', status: 'in_progress' }
  ],
  coverage: [
    { label: 'API Coverage', value: 80 },
    { label: 'Examples', value: 60 }
  ]
}
```

### Performance Analysis

**ID:** `performance-analysis`  
**Category:** Performance  

Performance investigation and optimization tracking.

**Fields:**
- `dashboard` - Title, status, progress
- `metrics` - Performance metrics
- `findings` - Performance bottlenecks
- `performanceTrend` - Before/after comparison

**Example:**
```javascript
{
  dashboard: {
    title: 'Homepage Performance',
    progress: 60
  },
  metrics: [
    { label: 'Load Time', value: 2.5 },
    { label: 'Bundle Size', value: 350 }
  ],
  performanceTrend: [
    { label: 'Baseline', value: 3.8 },
    { label: 'Optimized', value: 2.5 }
  ]
}
```

### Generic Workflow

**ID:** `generic`  
**Category:** General  

Basic template for any workflow type.

**Fields:**
- `dashboard` - Title, status, progress
- `phases` - Workflow phases
- `timeline` - Event timeline

## Using Templates

### 1. Create Session from Template

```javascript
// In your workflow
import { templateRegistry } from '@workrail/template-registry';

const data = templateRegistry.createFromTemplate('bug-investigation', {
  'dashboard.title': 'My Bug Investigation',
  'bugSummary': 'Description of the bug'
});

workrail.createSession('workflow-id', 'session-id', data);
```

### 2. Update During Workflow

```javascript
// Update hypothesis
workrail.updateSession('workflow-id', 'session-id', {
  hypotheses: [
    ...existingHypotheses,
    {
      description: 'New hypothesis',
      status: 'active',
      confidence: 6
    }
  ]
});
```

### 3. Add to Timeline

```javascript
// Log investigation step
workrail.updateSession('workflow-id', 'session-id', {
  timeline: [
    ...existingTimeline,
    {
      timestamp: new Date().toISOString(),
      event: 'Found root cause in auth service',
      reasoning: 'Token validation logic is incorrect'
    }
  ]
});
```

## Custom Templates

You can create custom templates for your organization:

```javascript
import { templateRegistry } from '@workrail/template-registry';

templateRegistry.register('deployment', {
  name: 'Deployment',
  description: 'Deployment workflow',
  category: 'operations',
  workflowType: 'generic',
  template: {
    dashboard: {
      title: 'Deployment: [Environment]',
      status: 'pending'
    },
    environment: 'staging',
    version: '1.0.0',
    steps: []
  },
  guide: {
    steps: [
      '1. Set environment and version',
      '2. Execute deployment steps',
      '3. Verify deployment'
    ],
    tips: [
      'Track each deployment step',
      'Include rollback procedures',
      'Document any issues encountered'
    ]
  }
});
```

## Template API

### `templateRegistry.list(category)`

List all templates, optionally filtered by category.

```javascript
const all = templateRegistry.list();
const debugging = templateRegistry.list('debugging');
```

### `templateRegistry.get(id)`

Get a template by ID.

```javascript
const template = templateRegistry.get('bug-investigation');
console.log(template.name, template.description);
```

### `templateRegistry.createFromTemplate(id, customizations)`

Create data from template with customizations.

```javascript
const data = templateRegistry.createFromTemplate('code-review', {
  'dashboard.title': 'PR #456',
  'summary': 'Looks good overall'
});
```

### `templateRegistry.getGuide(id)`

Get template usage guide.

```javascript
const guide = templateRegistry.getGuide('bug-investigation');
console.log(guide.steps);
console.log(guide.tips);
```

### `templateRegistry.exportTemplate(id)`

Export template as JSON string.

```javascript
const json = templateRegistry.exportTemplate('bug-investigation');
fs.writeFileSync('template.json', json);
```

## Best Practices

### 1. Start with a Template

Always start with the closest template to your workflow:

```javascript
// Instead of starting from scratch
const data = { dashboard: { title: '...' } };

// Use a template
const data = templateRegistry.createFromTemplate('bug-investigation');
```

### 2. Customize Incrementally

Add fields as needed - templates are starting points:

```javascript
const data = templateRegistry.createFromTemplate('bug-investigation');

// Add custom field
data.reproductionSteps = [
  'Step 1',
  'Step 2'
];
```

### 3. Follow Template Patterns

Templates use proven patterns that work well with the dashboard:

- Arrays with `label` + `value` → Charts
- Fields with `status` → Grouped lists
- Fields with `timestamp` → Timelines
- Fields with `severity` → Severity lists

### 4. Use Schemas

Templates specify recommended schemas - use them for validation:

```javascript
const template = templateRegistry.get('bug-investigation');
console.log(template.workflowType); // 'bug-investigation'

// Validate against schema
normalizer.normalize(data, { 
  workflowType: template.workflowType 
});
```

## FAQ

**Q: Can I modify templates?**  
A: Templates are cloned when used, so modifications don't affect the original.

**Q: Can I create my own templates?**  
A: Yes! Use `templateRegistry.register()` to add custom templates.

**Q: Do I have to use all fields in a template?**  
A: No, templates are starting points. Remove unused fields.

**Q: Can I add fields not in the template?**  
A: Absolutely! Add any fields you need.

**Q: Are templates validated?**  
A: Templates specify a recommended schema, but validation is optional.

## Examples

See `workflows/` directory for example workflows using templates.






