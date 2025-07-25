#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import os from 'os';
import { createWorkflowLookupServer } from './infrastructure/rpc/server';
import { DefaultWorkflowService } from './application/services/workflow-service';
// import { createDefaultWorkflowStorage } from './infrastructure/storage';
import { validateWorkflow } from './application/validation';
import { initializeUserWorkflowDirectory } from './infrastructure/storage/multi-directory-workflow-storage';
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
      
      const workflowService = new DefaultWorkflowService();
      const workflows = await workflowService.listWorkflowSummaries();
      
      if (workflows.length === 0) {
        console.log(chalk.yellow('   No workflows found.'));
        console.log(chalk.gray('   Run "workrail init" to create your first workflow.'));
        return;
      }
      
      workflows.forEach((workflow, index) => {
        console.log(chalk.green(`${index + 1}. ${workflow.name}`));
        console.log(chalk.white(`   ID: ${workflow.id}`));
        console.log(chalk.gray(`   ${workflow.description}`));
        
        if (options.verbose) {
          console.log(chalk.cyan(`   Version: ${workflow.version}`));
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
    const result = validateWorkflow(workflow);
    
    if (result.valid) {
      console.log(chalk.green('✅ Workflow is valid:'), filePath);
      process.exit(0);
    } else {
      console.error(chalk.red('❌ Workflow validation failed:'), filePath);
      console.error(chalk.yellow('\nValidation errors:'));
      result.errors.forEach(error => {
        console.error(chalk.red('  •'), error);
      });
      console.error(chalk.yellow(`\nFound ${result.errors.length} validation error${result.errors.length === 1 ? '' : 's'}.`));
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
      
      const workflowService = new DefaultWorkflowService();
      const server = createWorkflowLookupServer(workflowService);
      
      await server.start();
    } catch (error: any) {
      console.error(chalk.red('❌ Failed to start server:'), error.message);
      process.exit(1);
    }
  });

program.parse(); 