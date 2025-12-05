/**
 * SchemaRegistry
 * 
 * Manages data schemas for different workflow types.
 * Provides validation, type checking, and helpful error messages.
 * 
 * Schemas are optional - workflows work fine without them,
 * but schemas enable better validation and developer experience.
 */

export class SchemaRegistry {
  constructor() {
    this.schemas = new Map();
    this.registerBuiltInSchemas();
  }
  
  /**
   * Register built-in schemas for common workflows
   */
  registerBuiltInSchemas() {
    // Bug Investigation Schema
    this.register('bug-investigation', {
      name: 'Bug Investigation',
      description: 'Schema for systematic bug investigation workflows',
      fields: {
        dashboard: {
          type: 'object',
          required: true,
          description: 'Dashboard metadata',
          schema: {
            title: { type: 'string', required: true },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            progress: { type: 'number', min: 0, max: 100 },
            confidence: { type: 'number', min: 0, max: 10 }
          }
        },
        hypotheses: {
          type: 'array',
          description: 'List of hypotheses being tested',
          itemSchema: {
            description: { type: 'string', required: true },
            status: { type: 'string', enum: ['active', 'confirmed', 'rejected', 'partial'] },
            confidence: { type: 'number', min: 0, max: 10 },
            reasoning: { type: 'string' }
          }
        },
        timeline: {
          type: 'array',
          description: 'Investigation timeline events',
          itemSchema: {
            timestamp: { type: 'string', format: 'iso-date' },
            event: { type: 'string' },
            reasoning: { type: 'string' }
          }
        },
        recommendations: {
          type: 'array',
          description: 'Recommended actions',
          itemSchema: {
            description: { type: 'string', required: true },
            priority: { type: 'number', min: 0, max: 10 }
          }
        },
        bugSummary: { type: 'string', description: 'Brief bug description' },
        rootCause: { type: 'string', description: 'Identified root cause' },
        fix: { type: 'string', description: 'Proposed fix' }
      }
    });
    
    // Code Review Schema
    this.register('code-review', {
      name: 'Code Review',
      description: 'Schema for code review workflows',
      fields: {
        dashboard: {
          type: 'object',
          required: true,
          schema: {
            title: { type: 'string', required: true },
            status: { type: 'string', enum: ['pending', 'in_progress', 'approved', 'rejected'] },
            progress: { type: 'number', min: 0, max: 100 }
          }
        },
        changes: {
          type: 'array',
          description: 'Code changes to review',
          itemSchema: {
            file: { type: 'string', required: true },
            type: { type: 'string', enum: ['added', 'modified', 'deleted'] },
            linesAdded: { type: 'number', min: 0 },
            linesRemoved: { type: 'number', min: 0 }
          }
        },
        findings: {
          type: 'array',
          description: 'Review findings',
          itemSchema: {
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            description: { type: 'string', required: true },
            file: { type: 'string' },
            line: { type: 'number', min: 1 }
          }
        },
        summary: { type: 'string', description: 'Review summary' },
        approved: { type: 'boolean', description: 'Approval status' }
      }
    });
    
    // Test Results Schema
    this.register('test-results', {
      name: 'Test Results',
      description: 'Schema for test execution results',
      fields: {
        dashboard: {
          type: 'object',
          required: true,
          schema: {
            title: { type: 'string', required: true },
            status: { type: 'string', enum: ['running', 'passed', 'failed', 'skipped'] },
            progress: { type: 'number', min: 0, max: 100 }
          }
        },
        tests: {
          type: 'array',
          description: 'Test cases',
          itemSchema: {
            name: { type: 'string', required: true },
            status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
            duration: { type: 'number', min: 0 },
            error: { type: 'string' }
          }
        },
        summary: {
          type: 'object',
          description: 'Test summary statistics',
          schema: {
            total: { type: 'number', min: 0 },
            passed: { type: 'number', min: 0 },
            failed: { type: 'number', min: 0 },
            skipped: { type: 'number', min: 0 }
          }
        }
      }
    });
  }
  
  /**
   * Register a new schema
   */
  register(workflowType, schema) {
    if (!workflowType || typeof workflowType !== 'string') {
      throw new Error('Workflow type must be a non-empty string');
    }
    
    if (!schema || typeof schema !== 'object') {
      throw new Error('Schema must be an object');
    }
    
    this.schemas.set(workflowType, schema);
  }
  
  /**
   * Get schema for a workflow type
   */
  get(workflowType) {
    return this.schemas.get(workflowType);
  }
  
  /**
   * Check if a schema exists
   */
  has(workflowType) {
    return this.schemas.has(workflowType);
  }
  
  /**
   * Validate a value against a field schema
   */
  validateField(value, fieldSchema, path = '') {
    const errors = [];
    
    // Check required
    if (fieldSchema.required && (value === null || value === undefined)) {
      errors.push({
        path,
        message: 'Field is required',
        expected: fieldSchema.type
      });
      return errors;
    }
    
    // Skip validation if value is null/undefined and not required
    if (value === null || value === undefined) {
      return errors;
    }
    
    // Type validation
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (fieldSchema.type && actualType !== fieldSchema.type) {
      errors.push({
        path,
        message: `Expected type ${fieldSchema.type}, got ${actualType}`,
        expected: fieldSchema.type,
        actual: actualType
      });
      return errors;
    }
    
    // Type-specific validation
    switch (fieldSchema.type) {
      case 'string':
        errors.push(...this.validateString(value, fieldSchema, path));
        break;
      case 'number':
        errors.push(...this.validateNumber(value, fieldSchema, path));
        break;
      case 'boolean':
        // Boolean has no additional validation
        break;
      case 'array':
        errors.push(...this.validateArray(value, fieldSchema, path));
        break;
      case 'object':
        errors.push(...this.validateObject(value, fieldSchema, path));
        break;
    }
    
    return errors;
  }
  
  /**
   * Validate string field
   */
  validateString(value, fieldSchema, path) {
    const errors = [];
    
    // Enum validation
    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
      errors.push({
        path,
        message: `Value must be one of: ${fieldSchema.enum.join(', ')}`,
        expected: fieldSchema.enum,
        actual: value
      });
    }
    
    // Format validation
    if (fieldSchema.format === 'iso-date') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        errors.push({
          path,
          message: 'Value must be an ISO 8601 date',
          expected: 'ISO 8601 format',
          actual: value
        });
      }
    }
    
    // Length validation
    if (fieldSchema.minLength && value.length < fieldSchema.minLength) {
      errors.push({
        path,
        message: `String length must be at least ${fieldSchema.minLength}`,
        expected: `>= ${fieldSchema.minLength} characters`,
        actual: `${value.length} characters`
      });
    }
    
    if (fieldSchema.maxLength && value.length > fieldSchema.maxLength) {
      errors.push({
        path,
        message: `String length must not exceed ${fieldSchema.maxLength}`,
        expected: `<= ${fieldSchema.maxLength} characters`,
        actual: `${value.length} characters`
      });
    }
    
    return errors;
  }
  
  /**
   * Validate number field
   */
  validateNumber(value, fieldSchema, path) {
    const errors = [];
    
    // Range validation
    if (fieldSchema.min !== undefined && value < fieldSchema.min) {
      errors.push({
        path,
        message: `Value must be at least ${fieldSchema.min}`,
        expected: `>= ${fieldSchema.min}`,
        actual: value
      });
    }
    
    if (fieldSchema.max !== undefined && value > fieldSchema.max) {
      errors.push({
        path,
        message: `Value must not exceed ${fieldSchema.max}`,
        expected: `<= ${fieldSchema.max}`,
        actual: value
      });
    }
    
    // Integer validation
    if (fieldSchema.integer && !Number.isInteger(value)) {
      errors.push({
        path,
        message: 'Value must be an integer',
        expected: 'integer',
        actual: value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate array field
   */
  validateArray(value, fieldSchema, path) {
    const errors = [];
    
    // Length validation
    if (fieldSchema.minItems && value.length < fieldSchema.minItems) {
      errors.push({
        path,
        message: `Array must have at least ${fieldSchema.minItems} items`,
        expected: `>= ${fieldSchema.minItems} items`,
        actual: `${value.length} items`
      });
    }
    
    if (fieldSchema.maxItems && value.length > fieldSchema.maxItems) {
      errors.push({
        path,
        message: `Array must not exceed ${fieldSchema.maxItems} items`,
        expected: `<= ${fieldSchema.maxItems} items`,
        actual: `${value.length} items`
      });
    }
    
    // Item schema validation
    if (fieldSchema.itemSchema) {
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        const itemErrors = this.validateObject(item, { schema: fieldSchema.itemSchema }, itemPath);
        errors.push(...itemErrors);
      });
    }
    
    return errors;
  }
  
  /**
   * Validate object field
   */
  validateObject(value, fieldSchema, path) {
    const errors = [];
    
    if (!fieldSchema.schema) {
      return errors;
    }
    
    // Validate each field in schema
    for (const [key, subFieldSchema] of Object.entries(fieldSchema.schema)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const fieldValue = value[key];
      const fieldErrors = this.validateField(fieldValue, subFieldSchema, fieldPath);
      errors.push(...fieldErrors);
    }
    
    return errors;
  }
  
  /**
   * Validate data against a workflow schema
   */
  validate(data, workflowType) {
    const result = {
      valid: true,
      errors: [],
      warnings: []
    };
    
    try {
      // Check if schema exists
      const schema = this.get(workflowType);
      if (!schema) {
        result.warnings.push(`No schema found for workflow type: ${workflowType}`);
        return result;
      }
      
      // Validate data
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        result.valid = false;
        result.errors.push({
          path: '',
          message: 'Data must be an object',
          expected: 'object',
          actual: Array.isArray(data) ? 'array' : typeof data
        });
        return result;
      }
      
      // Validate each field in schema
      for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
        const fieldValue = data[fieldName];
        const fieldErrors = this.validateField(fieldValue, fieldSchema, fieldName);
        result.errors.push(...fieldErrors);
      }
      
      // Check for unknown fields (warnings, not errors)
      for (const fieldName of Object.keys(data)) {
        if (!schema.fields[fieldName] && fieldName !== 'workflowId' && fieldName !== 'sessionId') {
          result.warnings.push(`Unknown field: ${fieldName}`);
        }
      }
      
      result.valid = result.errors.length === 0;
      
    } catch (error) {
      result.valid = false;
      result.errors.push({
        path: '',
        message: `Validation error: ${error.message}`,
        error
      });
    }
    
    return result;
  }
  
  /**
   * Get validation summary for display
   */
  getValidationSummary(validationResult) {
    const { valid, errors, warnings } = validationResult;
    
    if (valid && warnings.length === 0) {
      return '✅ Data is valid';
    }
    
    const parts = [];
    
    if (!valid) {
      parts.push(`❌ ${errors.length} error(s) found:`);
      errors.forEach(err => {
        parts.push(`  • ${err.path || 'root'}: ${err.message}`);
      });
    }
    
    if (warnings.length > 0) {
      parts.push(`⚠️  ${warnings.length} warning(s):`);
      warnings.slice(0, 5).forEach(warning => {
        parts.push(`  • ${warning}`);
      });
      if (warnings.length > 5) {
        parts.push(`  ... and ${warnings.length - 5} more`);
      }
    }
    
    return parts.join('\n');
  }
  
  /**
   * Generate TypeScript interface from schema
   */
  generateTypeScript(workflowType) {
    const schema = this.get(workflowType);
    if (!schema) {
      return `// No schema found for ${workflowType}`;
    }
    
    const lines = [
      `// Generated TypeScript interface for ${schema.name}`,
      `// ${schema.description}`,
      '',
      `export interface ${this.toPascalCase(workflowType)}Data {`
    ];
    
    for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
      const optional = fieldSchema.required ? '' : '?';
      const tsType = this.toTypeScriptType(fieldSchema);
      const comment = fieldSchema.description ? `  /** ${fieldSchema.description} */\n` : '';
      lines.push(`${comment}  ${fieldName}${optional}: ${tsType};`);
    }
    
    lines.push('}');
    return lines.join('\n');
  }
  
  /**
   * Convert schema field to TypeScript type
   */
  toTypeScriptType(fieldSchema) {
    switch (fieldSchema.type) {
      case 'string':
        if (fieldSchema.enum) {
          return fieldSchema.enum.map(v => `'${v}'`).join(' | ');
        }
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        if (fieldSchema.itemSchema) {
          const itemType = this.schemaToTypeScriptType(fieldSchema.itemSchema);
          return `Array<${itemType}>`;
        }
        return 'Array<any>';
      case 'object':
        if (fieldSchema.schema) {
          return this.schemaToTypeScriptType(fieldSchema.schema);
        }
        return 'object';
      default:
        return 'any';
    }
  }
  
  /**
   * Convert schema object to TypeScript type
   */
  schemaToTypeScriptType(schema) {
    const fields = [];
    for (const [key, fieldSchema] of Object.entries(schema)) {
      const optional = fieldSchema.required ? '' : '?';
      const type = this.toTypeScriptType(fieldSchema);
      fields.push(`${key}${optional}: ${type}`);
    }
    return `{ ${fields.join('; ')} }`;
  }
  
  /**
   * Convert kebab-case to PascalCase
   */
  toPascalCase(str) {
    return str
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }
  
  /**
   * List all registered schemas
   */
  list() {
    return Array.from(this.schemas.entries()).map(([type, schema]) => ({
      type,
      name: schema.name,
      description: schema.description,
      fieldCount: Object.keys(schema.fields).length
    }));
  }
}

// Export singleton instance
export const schemaRegistry = new SchemaRegistry();






