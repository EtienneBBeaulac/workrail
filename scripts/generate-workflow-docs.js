#!/usr/bin/env node

/**
 * Generate docs/workflows.md from actual workflow JSON files
 * 
 * Usage: node scripts/generate-workflow-docs.js
 * 
 * Filters out:
 * - .agentic.json variants (feature-flagged)
 * - routines/ subdirectory (internal)
 * - examples/ subdirectory (not production workflows)
 */

const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', 'workflows');
const OUTPUT_FILE = path.join(__dirname, '..', 'docs', 'workflows.md');

// Categories for organization
const CATEGORIES = {
  development: {
    name: 'Development',
    description: 'Feature implementation and coding workflows',
    workflows: []
  },
  debugging: {
    name: 'Debugging',
    description: 'Bug investigation and troubleshooting',
    workflows: []
  },
  review: {
    name: 'Code Review',
    description: 'Merge request and code review processes',
    workflows: []
  },
  documentation: {
    name: 'Documentation',
    description: 'Creating and maintaining documentation',
    workflows: []
  },
  exploration: {
    name: 'Exploration & Analysis',
    description: 'Understanding codebases and systems',
    workflows: []
  },
  learning: {
    name: 'Learning & Education',
    description: 'Course design and learning materials',
    workflows: []
  },
  other: {
    name: 'Other',
    description: 'Miscellaneous workflows',
    workflows: []
  }
};

// Map workflow IDs to categories
function categorizeWorkflow(id, name) {
  const lower = (id + ' ' + name).toLowerCase();
  
  if (lower.includes('bug') || lower.includes('debug') || lower.includes('investigation')) {
    return 'debugging';
  }
  if (lower.includes('review') || lower.includes('mr-')) {
    return 'review';
  }
  if (lower.includes('document') || lower.includes('documentation')) {
    return 'documentation';
  }
  if (lower.includes('exploration') || lower.includes('ticket') || lower.includes('test-case')) {
    return 'exploration';
  }
  if (lower.includes('learning') || lower.includes('course') || lower.includes('presentation')) {
    return 'learning';
  }
  if (lower.includes('coding') || lower.includes('task') || lower.includes('feature')) {
    return 'development';
  }
  
  return 'other';
}

function loadWorkflows() {
  const files = fs.readdirSync(WORKFLOW_DIR);
  const workflows = [];
  
  for (const file of files) {
    // Skip directories
    const filePath = path.join(WORKFLOW_DIR, file);
    if (fs.statSync(filePath).isDirectory()) {
      continue;
    }
    
    // Skip non-JSON files
    if (!file.endsWith('.json')) {
      continue;
    }
    
    // Skip agentic variants (feature-flagged)
    if (file.includes('.agentic.')) {
      continue;
    }
    
    // Skip changelogs
    if (file.startsWith('CHANGELOG')) {
      continue;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const workflow = JSON.parse(content);
      
      workflows.push({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        stepsCount: workflow.steps?.length || 0,
        file: file
      });
    } catch (err) {
      console.error(`Warning: Could not parse ${file}: ${err.message}`);
    }
  }
  
  return workflows;
}

function generateMarkdown(workflows) {
  // Categorize workflows
  for (const workflow of workflows) {
    const category = categorizeWorkflow(workflow.id, workflow.name);
    CATEGORIES[category].workflows.push(workflow);
  }
  
  let md = `# Available Workflows

> **Auto-generated** from workflow files. Run \`workrail list\` for the latest.
>
> Last updated: ${new Date().toISOString().split('T')[0]}

## Overview

WorkRail includes **${workflows.length} production workflows** across multiple categories.

| Category | Count |
|----------|-------|
`;

  // Add category counts
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.workflows.length > 0) {
      md += `| ${cat.name} | ${cat.workflows.length} |\n`;
    }
  }

  md += `\n---\n\n`;

  // Add each category
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.workflows.length === 0) continue;
    
    md += `## ${cat.name}\n\n`;
    md += `${cat.description}\n\n`;
    
    for (const wf of cat.workflows) {
      md += `### \`${wf.id}\`\n\n`;
      md += `**${wf.name}** (v${wf.version})\n\n`;
      md += `${wf.description}\n\n`;
      md += `- **Steps**: ${wf.stepsCount}\n`;
      md += `- **File**: \`workflows/${wf.file}\`\n\n`;
    }
  }

  md += `---

## Using Workflows

Tell your AI agent which workflow to use:

\`\`\`
"Use the bug-investigation workflow to debug this issue"
"Use the coding-task-workflow-with-loops to implement this feature"
\`\`\`

Or browse programmatically:

\`\`\`bash
# List all workflows
workrail list

# Get details about a specific workflow
workrail list --verbose
\`\`\`

## Creating Custom Workflows

See the [Workflow Authoring Guide](authoring.md) to create your own workflows.
`;

  return md;
}

// Main
const workflows = loadWorkflows();
console.log(`Found ${workflows.length} workflows`);

const markdown = generateMarkdown(workflows);
fs.writeFileSync(OUTPUT_FILE, markdown);
console.log(`Generated ${OUTPUT_FILE}`);
