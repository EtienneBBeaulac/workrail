#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import os from 'os';
import { initializeContainer, container } from './di/container.js';
import { DI } from './di/tokens.js';
import { createWorkflowLookupServer } from './infrastructure/rpc/server';
import { Workflow } from './types/workflow-types';
import { WorkflowService } from './application/services/workflow-service.js';
import { ValidationEngine } from './application/services/validation-engine.js';
import { HttpServer } from './infrastructure/session/HttpServer.js';
import { initializeUserWorkflowDirectory } from './utils/workflow-init';
import { handleMigrationCommand } from './cli/migrate-workflow';

const program = new Command();

program
  .name('workrail')
  .description('MCP server for workflow orchestration and guidance')
  .version('0.0.3');

program
  .command('init')
  .description('Initialize user workflow directory with sample workflows')
  .action(async () => {
    try {
      console.log(chalk.blue('🚀 Initializing user workflow directory...'));
      
      const userDir = await initializeUserWorkflowDirectory();
      
      console.log(chalk.green('✅ User workflow directory initialized:'));
      console.log(chalk.cyan(`   ${userDir}`));
      console.log();
      console.log(chalk.yellow('📝 Getting started:'));
      console.log(chalk.white('1. Edit the sample workflow in the directory above'));
      console.log(chalk.white('2. Create new workflow JSON files following the schema'));
      console.log(chalk.white('3. Run "workrail list" to see your workflows'));
      console.log(chalk.white('4. Use your workflows with any MCP-enabled AI assistant'));
      console.log();
      console.log(chalk.gray('💡 Tip: Use "workrail validate <file>" to check your workflow syntax'));
    } catch (error: any) {
      console.error(chalk.red('❌ Failed to initialize user workflow directory:'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all available workflows from all sources')
  .option('-v, --verbose', 'Show detailed information including sources')
  .action(async (options) => {
    try {
      console.log(chalk.blue('📋 Available workflows:'));
      console.log();
      
      await initializeContainer();
      const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
      const workflows = await workflowService.listWorkflowSummaries();
      
      if (workflows.length === 0) {
        console.log(chalk.yellow('   No workflows found.'));
        console.log(chalk.gray('   Run "workrail init" to create your first workflow.'));
        return;
      }
      
      workflows.forEach((workflow: any, index: number) => {
        console.log(chalk.green(`${index + 1}. ${workflow.definition.name}`));
        console.log(chalk.white(`   ID: ${workflow.definition.id}`));
        console.log(chalk.gray(`   ${workflow.definition.description}`));
        
        if (options.verbose) {
          console.log(chalk.cyan(`   Version: ${workflow.definition.version}`));
        }
        
        console.log();
      });
      
      console.log(chalk.gray(`Total: ${workflows.length} workflows`));
    } catch (error: any) {
      console.error(chalk.red('❌ Failed to list workflows:'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('sources')
  .description('Show workflow directory sources and their status')
  .action(async () => {
    try {
      console.log(chalk.blue('📂 Workflow directory sources:'));
      console.log();
      
      const sources = [
        {
          name: 'Bundled Workflows',
          path: path.resolve(__dirname, '../workflows'),
          type: 'bundled',
          description: 'Pre-built workflows included with WorkRail'
        },
        {
          name: 'User Workflows',
          path: path.join(os.homedir(), '.workrail', 'workflows'),
          type: 'user',
          description: 'Your personal workflow collection'
        },
        {
          name: 'Project Workflows',
          path: path.resolve(process.cwd(), 'workflows'),
          type: 'project',
          description: 'Project-specific workflows'
        }
      ];
      
      // Add custom paths from environment
      const envPaths = process.env['WORKFLOW_STORAGE_PATH'];
      if (envPaths) {
        const customPaths = envPaths.split(path.delimiter);
        customPaths.forEach((customPath, index) => {
          sources.push({
            name: `Custom Path ${index + 1}`,
            path: path.resolve(customPath.trim()),
            type: 'custom',
            description: 'Custom workflow directory'
          });
        });
      }
      
      sources.forEach((source, index) => {
        const exists = fs.existsSync(source.path);
        const icon = exists ? '✅' : '❌';
        const status = exists ? 'Found' : 'Not found';
        
        console.log(chalk.white(`${index + 1}. ${source.name} ${icon}`));
        console.log(chalk.gray(`   Path: ${source.path}`));
        console.log(chalk.gray(`   Status: ${status}`));
        console.log(chalk.gray(`   ${source.description}`));
        
        if (exists) {
          try {
            const files = fs.readdirSync(source.path).filter(f => f.endsWith('.json'));
            console.log(chalk.cyan(`   Workflows: ${files.length} files`));
          } catch (error) {
            console.log(chalk.red(`   Error reading directory`));
          }
        }
        
        console.log();
      });
      
      console.log(chalk.yellow('💡 Tips:'));
      console.log(chalk.white('• Run "workrail init" to create the user workflow directory'));
      console.log(chalk.white('• Set WORKFLOW_STORAGE_PATH to add custom directories'));
      console.log(chalk.white('• Use colon-separated paths for multiple custom directories'));
    } catch (error: any) {
      console.error(chalk.red('❌ Failed to check workflow sources:'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

async function validateWorkflowFile(filePath: string): Promise<void> {
  try {
    // 1. Resolve and check file path
    const resolvedPath = path.resolve(filePath);
    
    if (!fs.existsSync(resolvedPath)) {
      console.error(chalk.red('❌ Error: File not found:'), filePath);
      console.error(chalk.yellow('\nPlease check the file path and try again.'));
      process.exit(1);
    }

    // 2. Read file content
    let content: string;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (error: any) {
      if (error.code === 'EACCES') {
        console.error(chalk.red('❌ Error: Permission denied:'), filePath);
        console.error(chalk.yellow('\nPlease check file permissions and try again.'));
      } else {
        console.error(chalk.red('❌ Error reading file:'), filePath);
        console.error(chalk.yellow(`\n${error.message}`));
      }
      process.exit(1);
    }

    // 3. Parse JSON
    let workflow: any;
    try {
      workflow = JSON.parse(content);
    } catch (error: any) {
      console.error(chalk.red('❌ Error: Invalid JSON syntax in'), filePath);
      console.error(chalk.yellow(`\n${error.message}`));
      console.error(chalk.yellow('\nPlease check the JSON syntax and try again.'));
      process.exit(1);
    }

    // 4. Validate workflow
    // First run schema validation (same as MCP server uses)
    const { validateWorkflow: schemaValidate } = await import('./application/validation');
    const schemaResult = schemaValidate(workflow);
    
    if (!schemaResult.valid) {
      console.error(chalk.red('❌ Workflow validation failed:'), filePath);
      console.error(chalk.yellow('\nValidation errors:'));
      schemaResult.errors.forEach(error => {
        console.error(chalk.red('  •'), error);
      });
      console.error(chalk.yellow('\nPlease fix the errors above and try again.'));
      process.exit(1);
    }
    
    // Then run structural validation (for warnings/info)
    await initializeContainer();
    const validationEngine = container.resolve<ValidationEngine>(DI.Infra.ValidationEngine);
    const result = validationEngine.validateWorkflow(workflow as Workflow);
    
    if (result.valid && !result.warnings?.length && !result.info?.length) {
      console.log(chalk.green('✅ Workflow is valid:'), filePath);
    } else if (result.valid) {
      console.log(chalk.green('✅ Workflow is valid with warnings:'), filePath);
      
      if (result.warnings && result.warnings.length > 0) {
        console.log(chalk.yellow('\n⚠️  Warnings:'));
        result.warnings.forEach((warning: any) => {
          console.log(chalk.yellow('  •'), warning);
        });
      }
      
      if (result.info && result.info.length > 0) {
        console.log(chalk.blue('\nℹ️  Information:'));
        result.info.forEach((info: any) => {
          console.log(chalk.blue('  •'), info);
        });
      }
      
      if (result.suggestions && result.suggestions.length > 0) {
        console.log(chalk.gray('\n💡 Suggestions:'));
        result.suggestions.forEach((suggestion: any) => {
          console.log(chalk.gray('  •'), suggestion);
        });
      }
    } else {
      console.error(chalk.red('❌ Workflow validation failed:'), filePath);
      console.error(chalk.yellow('\nValidation errors:'));
      result.issues.forEach((error: any) => {
        console.error(chalk.red('  •'), error);
      });
      console.error(chalk.yellow(`\nFound ${result.issues.length} validation error${result.issues.length === 1 ? '' : 's'}.`));
      
      if (result.suggestions && result.suggestions.length > 0) {
        console.log(chalk.gray('\n💡 Suggestions:'));
        result.suggestions.forEach((suggestion: any) => {
          console.log(chalk.gray('  •'), suggestion);
        });
      }
      
      process.exit(1);
    }
    
  } catch (error: any) {
    console.error(chalk.red('❌ Unexpected error:'), error.message);
    process.exit(1);
  }
}

program
  .command('validate <file>')
  .description('Validate a workflow file against the schema')
  .action(validateWorkflowFile);

program
  .command('migrate <file>')
  .description('Migrate a workflow from v0.0.1 to v0.1.0')
  .option('-o, --output <path>', 'Output file path (defaults to input file)')
  .option('-d, --dry-run', 'Show what would be changed without modifying files')
  .option('-b, --backup', 'Create a backup when overwriting the input file')
  .option('-q, --quiet', 'Suppress output except errors')
  .action(handleMigrationCommand);

program
  .command('start')
  .description('Start the MCP server')
  .action(async () => {
    try {
      console.log(chalk.blue('🚀 Starting WorkRail MCP server...'));
      
      await initializeContainer();
      const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
      const server = createWorkflowLookupServer(workflowService);
      
      await server.start();
    } catch (error: any) {
      console.error(chalk.red('❌ Failed to start server:'), error.message);
      process.exit(1);
    }
  });

program
  .command('cleanup')
  .description('Clean up orphaned workrail processes and free up ports')
  .option('-f, --force', 'Force cleanup without confirmation')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🧹 Cleaning up orphaned workrail processes...'));
      
      if (!options.force) {
        console.log(chalk.yellow('⚠️  This will terminate all workrail dashboard processes'));
        console.log(chalk.yellow('   Press Ctrl+C to cancel, or wait 3 seconds to continue...'));
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      await initializeContainer();
      const httpServer = container.resolve<HttpServer>(DI.Infra.HttpServer);
      
      const count = await httpServer.fullCleanup();
      
      if (count > 0) {
        console.log(chalk.green(`✅ Cleaned up ${count} orphaned process(es)`));
      } else {
        console.log(chalk.green('✅ No orphaned processes found'));
      }
    } catch (error: any) {
      console.error(chalk.red('❌ Cleanup failed:'), error.message);
      process.exit(1);
    }
  });

program.parse(); 