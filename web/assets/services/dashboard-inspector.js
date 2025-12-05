/**
 * DashboardInspector
 * 
 * Developer tool for inspecting, debugging, and understanding dashboard data.
 * Provides real-time insights into data structure, validation, and rendering.
 * 
 * Access via browser console: window.dashboardInspector
 */

export class DashboardInspector {
  constructor() {
    this.currentData = null;
    this.validationHistory = [];
    this.renderHistory = [];
    this.enabled = false;
  }
  
  /**
   * Enable inspector (attaches to window)
   */
  enable() {
    this.enabled = true;
    window.dashboardInspector = this;
    console.log('%c🔍 Dashboard Inspector Enabled', 'color: #8b5cf6; font-size: 14px; font-weight: bold;');
    console.log('Available commands:');
    console.log('  dashboardInspector.inspect() - Show current data');
    console.log('  dashboardInspector.validate() - Validate current data');
    console.log('  dashboardInspector.patterns() - Show recognized patterns');
    console.log('  dashboardInspector.suggestions() - Get field suggestions');
    console.log('  dashboardInspector.schema() - Show schema info');
    console.log('  dashboardInspector.history() - Show validation history');
  }
  
  /**
   * Set current data
   */
  setData(data) {
    this.currentData = data;
  }
  
  /**
   * Inspect current data
   */
  inspect(path = null) {
    if (!this.currentData) {
      console.warn('No data to inspect. Load a dashboard first.');
      return null;
    }
    
    if (path) {
      const value = this.getValueAtPath(this.currentData, path);
      console.group(`🔍 Inspecting: ${path}`);
      console.log('Value:', value);
      console.log('Type:', typeof value);
      if (Array.isArray(value)) {
        console.log('Array length:', value.length);
        if (value.length > 0) {
          console.log('First item:', value[0]);
        }
      } else if (typeof value === 'object' && value !== null) {
        console.log('Keys:', Object.keys(value));
      }
      console.groupEnd();
      return value;
    }
    
    console.group('🔍 Dashboard Data Inspection');
    console.log('Full data:', this.currentData);
    console.log('Top-level fields:', Object.keys(this.currentData));
    console.log('Field count:', Object.keys(this.currentData).length);
    
    // Analyze structure
    const analysis = this.analyzeStructure(this.currentData);
    console.log('\nStructure Analysis:');
    console.log('  Arrays:', analysis.arrays);
    console.log('  Objects:', analysis.objects);
    console.log('  Primitives:', analysis.primitives);
    console.log('  Total fields:', analysis.total);
    
    console.groupEnd();
    return this.currentData;
  }
  
  /**
   * Validate current data
   */
  validate(workflowType = null) {
    if (!this.currentData) {
      console.warn('No data to validate. Load a dashboard first.');
      return null;
    }
    
    // Import normalizer dynamically
    import('./data-normalizer.js').then(({ DataNormalizer }) => {
      const normalizer = new DataNormalizer();
      const result = normalizer.validateStructure(this.currentData, workflowType);
      
      this.validationHistory.push({
        timestamp: new Date().toISOString(),
        workflowType,
        result
      });
      
      console.group('✅ Validation Results');
      console.log('Valid:', result.valid ? '✅ Yes' : '❌ No');
      
      if (result.errors.length > 0) {
        console.group(`❌ Errors (${result.errors.length})`);
        result.errors.forEach((err, i) => {
          console.error(`${i + 1}. ${err}`);
        });
        console.groupEnd();
      }
      
      if (result.warnings.length > 0) {
        console.group(`⚠️  Warnings (${result.warnings.length})`);
        result.warnings.forEach((warn, i) => {
          console.warn(`${i + 1}. ${warn}`);
        });
        console.groupEnd();
      }
      
      if (result.valid && result.warnings.length === 0) {
        console.log('✨ All checks passed!');
      }
      
      console.groupEnd();
      return result;
    });
  }
  
  /**
   * Show recognized patterns
   */
  patterns() {
    if (!this.currentData) {
      console.warn('No data to analyze. Load a dashboard first.');
      return null;
    }
    
    import('./pattern-recognizer.js').then(({ PatternRecognizer }) => {
      const recognizer = new PatternRecognizer();
      const patterns = {};
      
      for (const [key, value] of Object.entries(this.currentData)) {
        const spec = recognizer.recognize(key, value);
        patterns[key] = {
          component: spec.component,
          priority: spec.priority,
          valueType: Array.isArray(value) ? 'array' : typeof value
        };
      }
      
      console.group('🎯 Recognized Patterns');
      console.table(patterns);
      console.groupEnd();
      
      return patterns;
    });
  }
  
  /**
   * Get field suggestions
   */
  suggestions() {
    if (!this.currentData) {
      console.warn('No data to analyze. Load a dashboard first.');
      return null;
    }
    
    import('./intent-analyzer.js').then(({ intentAnalyzer }) => {
      const suggestions = intentAnalyzer.getSuggestions(this.currentData);
      
      if (suggestions.length === 0) {
        console.log('✨ No suggestions - all field names are optimal!');
        return [];
      }
      
      console.group(`💡 Field Suggestions (${suggestions.length})`);
      suggestions.forEach((s, i) => {
        console.log(`${i + 1}. ${s.field} → ${s.canonical}`);
        console.log(`   Confidence: ${Math.round(s.confidence * 100)}%`);
        console.log(`   ${s.message}`);
        console.log('');
      });
      console.groupEnd();
      
      return suggestions;
    });
  }
  
  /**
   * Show schema information
   */
  schema(workflowType = 'bug-investigation') {
    import('./schema-registry.js').then(({ schemaRegistry }) => {
      if (!schemaRegistry.has(workflowType)) {
        console.warn(`No schema found for workflow type: ${workflowType}`);
        console.log('Available schemas:', schemaRegistry.list().map(s => s.type));
        return null;
      }
      
      const schema = schemaRegistry.get(workflowType);
      
      console.group(`📋 Schema: ${schema.name}`);
      console.log('Description:', schema.description);
      console.log('Fields:', Object.keys(schema.fields).length);
      console.log('\nField Details:');
      
      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        console.group(`  ${fieldName}`);
        console.log('Type:', fieldDef.type);
        console.log('Required:', fieldDef.required || false);
        if (fieldDef.description) {
          console.log('Description:', fieldDef.description);
        }
        console.groupEnd();
      }
      
      console.groupEnd();
      
      // Generate TypeScript
      const typescript = schemaRegistry.generateTypeScript(workflowType);
      console.group('TypeScript Interface');
      console.log(typescript);
      console.groupEnd();
      
      return schema;
    });
  }
  
  /**
   * Show validation history
   */
  history() {
    if (this.validationHistory.length === 0) {
      console.log('No validation history yet. Run validate() first.');
      return [];
    }
    
    console.group(`📊 Validation History (${this.validationHistory.length} runs)`);
    this.validationHistory.forEach((entry, i) => {
      console.group(`${i + 1}. ${entry.timestamp}`);
      console.log('Workflow Type:', entry.workflowType || 'none');
      console.log('Valid:', entry.result.valid);
      console.log('Errors:', entry.result.errors.length);
      console.log('Warnings:', entry.result.warnings.length);
      console.groupEnd();
    });
    console.groupEnd();
    
    return this.validationHistory;
  }
  
  /**
   * Analyze data structure
   */
  analyzeStructure(data, prefix = '') {
    const analysis = {
      arrays: [],
      objects: [],
      primitives: [],
      total: 0
    };
    
    for (const [key, value] of Object.entries(data)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      analysis.total++;
      
      if (Array.isArray(value)) {
        analysis.arrays.push({ path: fullPath, length: value.length });
      } else if (typeof value === 'object' && value !== null) {
        analysis.objects.push(fullPath);
      } else {
        analysis.primitives.push({ path: fullPath, type: typeof value });
      }
    }
    
    return analysis;
  }
  
  /**
   * Get value at path (e.g., "dashboard.title")
   */
  getValueAtPath(data, path) {
    const parts = path.split('.');
    let current = data;
    
    for (const part of parts) {
      if (current && typeof current === 'object') {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
  }
  
  /**
   * Export current data as JSON
   */
  export() {
    if (!this.currentData) {
      console.warn('No data to export.');
      return null;
    }
    
    const json = JSON.stringify(this.currentData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `dashboard-data-${Date.now()}.json`;
    a.click();
    
    console.log('✅ Data exported');
    return json;
  }
  
  /**
   * Compare two data objects
   */
  compare(data1, data2) {
    const diff = {
      added: [],
      removed: [],
      changed: []
    };
    
    const keys1 = new Set(Object.keys(data1));
    const keys2 = new Set(Object.keys(data2));
    
    // Find added keys
    for (const key of keys2) {
      if (!keys1.has(key)) {
        diff.added.push(key);
      }
    }
    
    // Find removed keys
    for (const key of keys1) {
      if (!keys2.has(key)) {
        diff.removed.push(key);
      }
    }
    
    // Find changed keys
    for (const key of keys1) {
      if (keys2.has(key)) {
        const val1 = JSON.stringify(data1[key]);
        const val2 = JSON.stringify(data2[key]);
        if (val1 !== val2) {
          diff.changed.push(key);
        }
      }
    }
    
    console.group('🔄 Data Comparison');
    if (diff.added.length > 0) {
      console.log('Added:', diff.added);
    }
    if (diff.removed.length > 0) {
      console.log('Removed:', diff.removed);
    }
    if (diff.changed.length > 0) {
      console.log('Changed:', diff.changed);
    }
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
      console.log('✅ Data is identical');
    }
    console.groupEnd();
    
    return diff;
  }
  
  /**
   * Performance profiling
   */
  profile(fn, label = 'Operation') {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    const duration = end - start;
    
    console.log(`⏱️  ${label}: ${duration.toFixed(2)}ms`);
    return { result, duration };
  }
  
  /**
   * Memory usage (approximate)
   */
  memoryUsage() {
    if (!this.currentData) {
      console.warn('No data loaded.');
      return 0;
    }
    
    const json = JSON.stringify(this.currentData);
    const bytes = new Blob([json]).size;
    const kb = bytes / 1024;
    const mb = kb / 1024;
    
    console.group('💾 Memory Usage');
    console.log('Bytes:', bytes);
    console.log('Kilobytes:', kb.toFixed(2), 'KB');
    if (mb > 1) {
      console.log('Megabytes:', mb.toFixed(2), 'MB');
    }
    console.groupEnd();
    
    return bytes;
  }
}

// Export singleton instance
export const dashboardInspector = new DashboardInspector();






