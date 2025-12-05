/**
 * TemplateRegistry
 * 
 * Registry of workflow templates to help authors get started quickly.
 * Provides pre-configured templates for common workflow types.
 */

export class TemplateRegistry {
  constructor() {
    this.templates = new Map();
    this.registerBuiltInTemplates();
  }
  
  /**
   * Register built-in templates
   */
  registerBuiltInTemplates() {
    // Bug Investigation Template
    this.register('bug-investigation', {
      name: 'Bug Investigation',
      description: 'Systematic bug investigation workflow with hypotheses and timeline',
      category: 'debugging',
      workflowType: 'bug-investigation',
      template: {
        dashboard: {
          title: 'Bug Investigation: [Bug Title]',
          subtitle: '[Brief description of the bug]',
          status: 'in_progress',
          progress: 0,
          confidence: 5
        },
        bugSummary: '[Detailed description of the bug and symptoms]',
        hypotheses: [
          {
            description: '[First hypothesis about the cause]',
            status: 'active',
            confidence: 5,
            reasoning: '[Why this might be the cause]'
          }
        ],
        timeline: [
          {
            timestamp: new Date().toISOString(),
            event: 'Investigation started',
            reasoning: '[Initial observations]'
          }
        ],
        phases: {
          'phase-1': {
            name: 'Initial Analysis',
            complete: false,
            summary: '[What was done in this phase]'
          }
        }
      },
      guide: {
        steps: [
          '1. Update dashboard.title and bugSummary with bug details',
          '2. Add initial hypotheses about possible causes',
          '3. Log investigation steps in timeline',
          '4. Update hypothesis status as you test them',
          '5. Add recommendations when cause is identified'
        ],
        tips: [
          'Use confidence scores (0-10) to track certainty',
          'Keep timeline updated with key findings',
          'Mark hypotheses as confirmed/rejected/partial',
          'Update progress as investigation advances'
        ]
      }
    });
    
    // Code Review Template
    this.register('code-review', {
      name: 'Code Review',
      description: 'Code review workflow with findings and approvals',
      category: 'quality',
      workflowType: 'code-review',
      template: {
        dashboard: {
          title: 'Code Review: [PR/MR Title]',
          subtitle: '[Brief description of changes]',
          status: 'in_progress',
          progress: 0
        },
        summary: '[Overall review summary]',
        changes: [
          {
            file: '[path/to/file]',
            type: 'modified',
            linesAdded: 0,
            linesRemoved: 0
          }
        ],
        findings: [
          {
            severity: 'medium',
            description: '[Issue description]',
            file: '[affected file]',
            line: 0,
            suggestion: '[How to fix]'
          }
        ],
        approved: false
      },
      guide: {
        steps: [
          '1. Update dashboard with PR/MR title',
          '2. List all changed files in changes array',
          '3. Document findings with severity levels',
          '4. Set approved to true/false based on review',
          '5. Update summary with overall assessment'
        ],
        tips: [
          'Use severity: critical/high/medium/low/info',
          'Include line numbers for specific issues',
          'Provide actionable suggestions for fixes',
          'Track progress as issues are addressed'
        ]
      }
    });
    
    // Test Results Template
    this.register('test-results', {
      name: 'Test Results',
      description: 'Test execution results with pass/fail tracking',
      category: 'testing',
      workflowType: 'test-results',
      template: {
        dashboard: {
          title: 'Test Run: [Test Suite Name]',
          subtitle: '[Environment or context]',
          status: 'running',
          progress: 0
        },
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0
        },
        tests: [
          {
            name: '[Test name]',
            status: 'passed',
            duration: 0,
            error: null
          }
        ],
        testResultsTrend: [
          {
            label: 'Current',
            value: 0
          }
        ]
      },
      guide: {
        steps: [
          '1. Update dashboard with test suite name',
          '2. Initialize summary with test counts',
          '3. Add individual test results to tests array',
          '4. Update progress as tests execute',
          '5. Set final status to passed/failed'
        ],
        tips: [
          'Use testResultsTrend for historical comparison',
          'Include error messages for failed tests',
          'Track duration for performance monitoring',
          'Update summary totals as tests complete'
        ]
      }
    });
    
    // Documentation Template
    this.register('documentation', {
      name: 'Documentation',
      description: 'Documentation generation workflow',
      category: 'documentation',
      workflowType: 'generic',
      template: {
        dashboard: {
          title: 'Documentation: [Component/Feature Name]',
          subtitle: '[Brief description]',
          status: 'in_progress',
          progress: 0
        },
        sections: [
          {
            title: 'Overview',
            status: 'complete',
            content: '[Section content]'
          },
          {
            title: 'Usage',
            status: 'in_progress',
            content: '[Section content]'
          }
        ],
        coverage: [
          {
            label: 'API Coverage',
            value: 75
          },
          {
            label: 'Examples',
            value: 50
          }
        ]
      },
      guide: {
        steps: [
          '1. Update dashboard with documentation subject',
          '2. Break down into logical sections',
          '3. Track completion status for each section',
          '4. Use coverage for metrics',
          '5. Update progress as sections are completed'
        ],
        tips: [
          'Keep sections focused and concise',
          'Use coverage metrics to track completeness',
          'Mark sections as complete when reviewed',
          'Include examples and code snippets'
        ]
      }
    });
    
    // Performance Analysis Template
    this.register('performance-analysis', {
      name: 'Performance Analysis',
      description: 'Performance investigation and optimization',
      category: 'performance',
      workflowType: 'generic',
      template: {
        dashboard: {
          title: 'Performance Analysis: [Component/Feature]',
          subtitle: '[Performance issue description]',
          status: 'in_progress',
          progress: 0
        },
        metrics: [
          {
            label: 'Load Time',
            value: 0
          },
          {
            label: 'Bundle Size',
            value: 0
          }
        ],
        findings: [
          {
            severity: 'high',
            description: '[Performance bottleneck]',
            impact: '[Impact description]',
            recommendation: '[Optimization suggestion]'
          }
        ],
        performanceTrend: [
          {
            label: 'Baseline',
            value: 0
          },
          {
            label: 'Current',
            value: 0
          }
        ]
      },
      guide: {
        steps: [
          '1. Document baseline performance metrics',
          '2. Identify performance bottlenecks',
          '3. Add findings with severity and impact',
          '4. Track improvements in performanceTrend',
          '5. Document recommendations'
        ],
        tips: [
          'Use charts to visualize performance trends',
          'Include before/after comparisons',
          'Prioritize findings by severity and impact',
          'Track metrics over time'
        ]
      }
    });
    
    // Generic Workflow Template
    this.register('generic', {
      name: 'Generic Workflow',
      description: 'Basic template for any workflow',
      category: 'general',
      workflowType: 'generic',
      template: {
        dashboard: {
          title: '[Workflow Title]',
          subtitle: '[Brief description]',
          status: 'in_progress',
          progress: 0
        },
        phases: {
          'phase-1': {
            name: 'Phase 1',
            complete: false,
            summary: '[Phase summary]'
          }
        },
        timeline: [
          {
            timestamp: new Date().toISOString(),
            event: 'Workflow started'
          }
        ]
      },
      guide: {
        steps: [
          '1. Update dashboard with workflow details',
          '2. Define phases for your workflow',
          '3. Add timeline events as work progresses',
          '4. Use any field names that make sense',
          '5. Dashboard will auto-detect patterns'
        ],
        tips: [
          'The dashboard auto-recognizes data patterns',
          'Use arrays with label+value for charts',
          'Add status fields for grouping',
          'Include timestamps for timelines',
          'Use confidence/priority for ordering'
        ]
      }
    });
  }
  
  /**
   * Register a custom template
   */
  register(id, template) {
    if (!id || typeof id !== 'string') {
      throw new Error('Template ID must be a non-empty string');
    }
    
    if (!template || typeof template !== 'object') {
      throw new Error('Template must be an object');
    }
    
    if (!template.name || !template.template) {
      throw new Error('Template must have name and template properties');
    }
    
    this.templates.set(id, template);
  }
  
  /**
   * Get a template by ID
   */
  get(id) {
    return this.templates.get(id);
  }
  
  /**
   * Check if template exists
   */
  has(id) {
    return this.templates.has(id);
  }
  
  /**
   * List all templates
   */
  list(category = null) {
    const templates = Array.from(this.templates.entries()).map(([id, template]) => ({
      id,
      name: template.name,
      description: template.description,
      category: template.category,
      workflowType: template.workflowType
    }));
    
    if (category) {
      return templates.filter(t => t.category === category);
    }
    
    return templates;
  }
  
  /**
   * Get categories
   */
  getCategories() {
    const categories = new Set();
    for (const template of this.templates.values()) {
      if (template.category) {
        categories.add(template.category);
      }
    }
    return Array.from(categories).sort();
  }
  
  /**
   * Create session data from template
   */
  createFromTemplate(templateId, customizations = {}) {
    const template = this.get(templateId);
    
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    
    // Deep clone template
    const data = JSON.parse(JSON.stringify(template.template));
    
    // Apply customizations
    return this.applyCustomizations(data, customizations);
  }
  
  /**
   * Apply customizations to template data
   */
  applyCustomizations(data, customizations) {
    for (const [path, value] of Object.entries(customizations)) {
      const parts = path.split('.');
      let current = data;
      
      // Navigate to parent
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) {
          current[part] = {};
        }
        current = current[part];
      }
      
      // Set value
      const lastPart = parts[parts.length - 1];
      current[lastPart] = value;
    }
    
    return data;
  }
  
  /**
   * Get template guide
   */
  getGuide(templateId) {
    const template = this.get(templateId);
    return template ? template.guide : null;
  }
  
  /**
   * Export template as JSON
   */
  exportTemplate(templateId) {
    const template = this.get(templateId);
    
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    
    return JSON.stringify(template, null, 2);
  }
  
  /**
   * Generate example workflow from template
   */
  generateExample(templateId) {
    const template = this.get(templateId);
    
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    
    return {
      workflowType: template.workflowType,
      name: `Example ${template.name}`,
      description: template.description,
      steps: [
        {
          id: 'setup',
          description: 'Initialize workflow',
          instructions: [
            `Create session with ${template.name} template:`,
            '```javascript',
            `const data = templateRegistry.createFromTemplate('${templateId}', {`,
            `  'dashboard.title': 'My ${template.name}'`,
            '});',
            'workrail.createSession(workflowId, sessionId, data);',
            '```'
          ]
        },
        ...(template.guide?.steps || []).map((step, i) => ({
          id: `step-${i + 1}`,
          description: step
        }))
      ]
    };
  }
}

// Export singleton instance
export const templateRegistry = new TemplateRegistry();






