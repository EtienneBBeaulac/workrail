#!/usr/bin/env node

/**
 * Create Workflow from Template CLI
 * 
 * Generate a new workflow from a pre-built template.
 * 
 * Usage:
 *   node scripts/create-from-template.js [template-id]
 *   
 * Examples:
 *   node scripts/create-from-template.js bug-investigation
 *   node scripts/create-from-template.js --list
 */

import { writeFile } from 'fs/promises';
import { resolve } from 'path';

// Color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function createFromTemplate() {
  const args = process.argv.slice(2);
  
  // Import template registry
  const { templateRegistry } = await import('../web/assets/services/template-registry.js');
  
  // List templates
  if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
    log('\n📋 Available Templates\n', 'bright');
    
    const categories = templateRegistry.getCategories();
    
    for (const category of categories) {
      log(`${category.toUpperCase()}:`, 'cyan');
      const templates = templateRegistry.list(category);
      
      for (const template of templates) {
        log(`  • ${template.id}`, 'green');
        log(`    ${template.description}`, 'gray');
      }
      log('');
    }
    
    log('Usage:', 'cyan');
    log('  create-from-template <template-id>\n');
    return;
  }
  
  // Show help
  if (args[0] === '--help' || args[0] === '-h') {
    log('Create Workflow from Template', 'bright');
    log('\nUsage:', 'cyan');
    log('  create-from-template <template-id>\n');
    log('Examples:');
    log('  create-from-template bug-investigation');
    log('  create-from-template code-review');
    log('  create-from-template --list\n');
    return;
  }
  
  const templateId = args[0];
  
  if (!templateRegistry.has(templateId)) {
    log(`\n❌ Template not found: ${templateId}`, 'yellow');
    log('\nAvailable templates:', 'cyan');
    const templates = templateRegistry.list();
    templates.forEach(t => log(`  • ${t.id}`, 'green'));
    log('\nUse --list to see details\n');
    process.exit(1);
  }
  
  try {
    const template = templateRegistry.get(templateId);
    
    log(`\n✨ Creating workflow from template: ${template.name}`, 'bright');
    log(`   ${template.description}\n`, 'gray');
    
    // Create data from template
    const data = templateRegistry.createFromTemplate(templateId);
    
    // Generate filename
    const filename = `${templateId}-workflow.json`;
    const filepath = resolve(process.cwd(), filename);
    
    // Write file
    await writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
    
    log(`✅ Created: ${filename}`, 'green');
    
    // Show guide
    const guide = templateRegistry.getGuide(templateId);
    if (guide) {
      log(`\n📖 Quick Start Guide:\n`, 'cyan');
      
      if (guide.steps) {
        log('Steps:', 'yellow');
        guide.steps.forEach(step => log(`  ${step}`, 'gray'));
        log('');
      }
      
      if (guide.tips) {
        log('Tips:', 'yellow');
        guide.tips.forEach(tip => log(`  💡 ${tip}`, 'gray'));
        log('');
      }
    }
    
    log('Next steps:', 'cyan');
    log(`  1. Edit ${filename} with your specific data`);
    log(`  2. Use this data in your workflow`);
    log(`  3. Dashboard will auto-generate based on the data\n`);
    
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'yellow');
    process.exit(1);
  }
}

createFromTemplate();






