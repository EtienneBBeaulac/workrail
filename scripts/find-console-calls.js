#!/usr/bin/env node

/**
 * Find all console.* calls in src/ with context
 * 
 * Usage: node scripts/find-console-calls.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '../src');

// Patterns to find
const consolePattern = /console\.(log|error|warn|info|debug|trace)\s*\(/g;

// Files/patterns to exclude
const exclude = [
  'node_modules',
  'dist',
  '.test.ts',
  '.test.js',
];

function shouldExclude(filePath) {
  return exclude.some(pattern => filePath.includes(pattern));
}

function findTsFiles(dir) {
  const files = [];
  
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      
      if (entry.isDirectory() && !shouldExclude(fullPath)) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !shouldExclude(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const matches = [];
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const match = line.match(consolePattern);
    
    if (match) {
      // Get context (surrounding lines)
      const contextStart = Math.max(0, index - 2);
      const contextEnd = Math.min(lines.length, index + 3);
      const context = lines.slice(contextStart, contextEnd);
      
      matches.push({
        lineNum,
        line: line.trim(),
        method: match[0],
        context: context.map((l, i) => ({
          lineNum: contextStart + i + 1,
          line: l,
          isCurrent: contextStart + i === index
        }))
      });
    }
  });
  
  return matches;
}

function categorize(filePath, line) {
  // Categorization logic
  if (filePath.includes('src/cli.ts') || filePath.includes('src/cli/')) {
    return { category: 'CLI', action: 'KEEP', reason: 'User-facing output' };
  }
  
  if (filePath.includes('session-watcher-state.ts') && line.includes('NODE_ENV')) {
    return { category: 'UTILITY', action: 'KEEP', reason: 'Pure utility, env-gated' };
  }
  
  if (line.includes('DEPRECATION')) {
    return { category: 'DEPRECATION', action: 'KEEP', reason: 'User-facing warning' };
  }
  
  if (filePath.includes('HttpServer.ts')) {
    return { category: 'SINGLETON', action: 'INJECT', reason: '@singleton() - inject ILoggerFactory' };
  }
  
  if (filePath.includes('feature-flags.ts')) {
    return { category: 'SINGLETON', action: 'INJECT', reason: '@singleton() - inject ILoggerFactory' };
  }
  
  if (filePath.includes('SessionManager.ts')) {
    return { category: 'SINGLETON', action: 'INJECT', reason: '@singleton() - inject ILoggerFactory' };
  }
  
  if (filePath.includes('mcp-server.ts') || filePath.includes('rpc-server.ts')) {
    return { category: 'ENTRY_POINT', action: 'BOOTSTRAP', reason: 'Use bootstrap logger' };
  }
  
  if (filePath.includes('/storage/')) {
    return { category: 'STORAGE', action: 'PASS_LOGGER', reason: 'Pass logger via constructor' };
  }
  
  if (filePath.includes('utils/')) {
    return { category: 'UTILITY', action: 'BOOTSTRAP', reason: 'Pure function - use bootstrap or skip' };
  }
  
  return { category: 'OTHER', action: 'REVIEW', reason: 'Needs manual review' };
}

// Main
const files = findTsFiles(srcDir);
const results = [];

for (const filePath of files) {
  const matches = analyzeFile(filePath);
  if (matches.length > 0) {
    results.push({
      file: path.relative(process.cwd(), filePath),
      matches
    });
  }
}

// Group by category
const byCategory = {};
const summary = {
  total: 0,
  byAction: {},
  byCategory: {}
};

for (const result of results) {
  for (const match of result.matches) {
    const cat = categorize(result.file, match.line);
    
    if (!byCategory[cat.category]) {
      byCategory[cat.category] = [];
    }
    
    byCategory[cat.category].push({
      file: result.file,
      lineNum: match.lineNum,
      line: match.line,
      method: match.method,
      action: cat.action,
      reason: cat.reason,
      context: match.context
    });
    
    summary.total++;
    summary.byAction[cat.action] = (summary.byAction[cat.action] || 0) + 1;
    summary.byCategory[cat.category] = (summary.byCategory[cat.category] || 0) + 1;
  }
}

// Output
console.log('═══════════════════════════════════════════════════════════');
console.log('  Console Call Migration Analysis');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Total console.* calls found: ${summary.total}\n`);

console.log('By Category:');
Object.entries(summary.byCategory)
  .sort(([, a], [, b]) => b - a)
  .forEach(([cat, count]) => {
    console.log(`  ${cat.padEnd(20)} ${count}`);
  });

console.log('\nBy Action Required:');
Object.entries(summary.byAction)
  .sort(([, a], [, b]) => b - a)
  .forEach(([action, count]) => {
    console.log(`  ${action.padEnd(20)} ${count}`);
  });

console.log('\n' + '═'.repeat(60) + '\n');

// Detailed output by category
for (const [category, items] of Object.entries(byCategory)) {
  console.log(`\n### ${category} (${items.length} calls)`);
  console.log('─'.repeat(60));
  
  // Group by file
  const byFile = {};
  for (const item of items) {
    if (!byFile[item.file]) byFile[item.file] = [];
    byFile[item.file].push(item);
  }
  
  for (const [file, fileItems] of Object.entries(byFile)) {
    console.log(`\n📄 ${file}`);
    console.log(`   Action: ${fileItems[0].action} - ${fileItems[0].reason}`);
    
    for (const item of fileItems) {
      console.log(`   Line ${item.lineNum}: ${item.method}`);
      console.log(`      ${item.line.substring(0, 80)}${item.line.length > 80 ? '...' : ''}`);
    }
  }
}

console.log('\n' + '═'.repeat(60));
console.log('\n✨ Run with --json flag for machine-readable output\n');

// JSON output if requested
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, byCategory }, null, 2));
}
