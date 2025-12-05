#!/usr/bin/env node

/**
 * Dashboard Data Validator CLI
 * 
 * Validates dashboard session data against schemas and provides helpful feedback.
 * 
 * Usage:
 *   node scripts/validate-dashboard.js <session-file> [workflow-type]
 *   
 * Examples:
 *   node scripts/validate-dashboard.js sessions/bug-investigation/BUG-001/session.json
 *   node scripts/validate-dashboard.js sessions/test/session.json bug-investigation
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(text) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`  ${text}`, 'bright');
  log('='.repeat(60), 'cyan');
}

async function validateDashboard() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    log('Dashboard Data Validator', 'bright');
    log('\nUsage:', 'cyan');
    log('  validate-dashboard <session-file> [workflow-type]\n');
    log('Examples:');
    log('  validate-dashboard sessions/bug-investigation/BUG-001/session.json');
    log('  validate-dashboard sessions/test/session.json bug-investigation\n');
    process.exit(0);
  }
  
  const sessionFile = args[0];
  const workflowType = args[1] || null;
  
  try {
    // Read session file
    const filePath = resolve(process.cwd(), sessionFile);
    log(`\n📄 Reading: ${sessionFile}`, 'gray');
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    // Import validation modules
    const { DataNormalizer } = await import('../web/assets/services/data-normalizer.js');
    const { schemaRegistry } = await import('../web/assets/services/schema-registry.js');
    const { intentAnalyzer } = await import('../web/assets/services/intent-analyzer.js');
    
    // Basic structure validation
    header('Structure Validation');
    
    const normalizer = new DataNormalizer();
    const result = normalizer.validateStructure(data, workflowType);
    
    if (result.valid) {
      log('✅ Structure is valid', 'green');
    } else {
      log('❌ Structure validation failed', 'red');
    }
    
    // Show errors
    if (result.errors.length > 0) {
      log(`\n❌ Errors (${result.errors.length}):`, 'red');
      result.errors.forEach((err, i) => {
        log(`  ${i + 1}. ${err}`, 'red');
      });
    }
    
    // Show warnings
    if (result.warnings.length > 0) {
      log(`\n⚠️  Warnings (${result.warnings.length}):`, 'yellow');
      result.warnings.forEach((warn, i) => {
        log(`  ${i + 1}. ${warn}`, 'yellow');
      });
    }
    
    // Schema validation
    if (workflowType && schemaRegistry.has(workflowType)) {
      header('Schema Validation');
      
      const schemaResult = schemaRegistry.validate(data, workflowType);
      
      if (schemaResult.valid) {
        log('✅ Schema validation passed', 'green');
      } else {
        log('❌ Schema validation failed', 'red');
        
        log(`\n❌ Schema Errors (${schemaResult.errors.length}):`, 'red');
        schemaResult.errors.forEach((err, i) => {
          log(`  ${i + 1}. ${err.path}: ${err.message}`, 'red');
          if (err.expected && err.actual) {
            log(`     Expected: ${JSON.stringify(err.expected)}`, 'gray');
            log(`     Actual: ${JSON.stringify(err.actual)}`, 'gray');
          }
        });
      }
    }
    
    // Field suggestions
    header('Field Name Suggestions');
    
    const suggestions = intentAnalyzer.getSuggestions(data);
    
    if (suggestions.length === 0) {
      log('✅ All field names are optimal', 'green');
    } else {
      log(`💡 ${suggestions.length} suggestion(s) for better recognition:\n`, 'cyan');
      suggestions.forEach((s, i) => {
        log(`  ${i + 1}. ${s.field} → ${s.canonical}`, 'cyan');
        log(`     Confidence: ${Math.round(s.confidence * 100)}%`, 'gray');
        log(`     ${s.message}`, 'gray');
        log('');
      });
    }
    
    // Data statistics
    header('Data Statistics');
    
    const stats = {
      totalFields: Object.keys(data).length,
      arrays: 0,
      objects: 0,
      primitives: 0,
      totalSize: JSON.stringify(data).length
    };
    
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) {
        stats.arrays++;
      } else if (typeof value === 'object' && value !== null) {
        stats.objects++;
      } else {
        stats.primitives++;
      }
    }
    
    log(`📊 Total Fields: ${stats.totalFields}`);
    log(`   Arrays: ${stats.arrays}`);
    log(`   Objects: ${stats.objects}`);
    log(`   Primitives: ${stats.primitives}`);
    log(`   Size: ${(stats.totalSize / 1024).toFixed(2)} KB\n`);
    
    // Summary
    header('Summary');
    
    const hasErrors = result.errors.length > 0 || (workflowType && schemaRegistry.has(workflowType) && !schemaRegistry.validate(data, workflowType).valid);
    const hasWarnings = result.warnings.length > 0;
    
    if (!hasErrors && !hasWarnings && suggestions.length === 0) {
      log('✅ Perfect! No issues found.', 'green');
      process.exit(0);
    } else if (!hasErrors) {
      log('⚠️  Validation passed with warnings or suggestions.', 'yellow');
      process.exit(0);
    } else {
      log('❌ Validation failed. Please fix the errors above.', 'red');
      process.exit(1);
    }
    
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    if (error.stack) {
      log(error.stack, 'gray');
    }
    process.exit(1);
  }
}

validateDashboard();






