import fs from 'fs';
import path from 'path';
import { Workflow } from '../types/mcp-types';
import { validateWorkflow } from '../application/validation';
import chalk from 'chalk';
import semver from 'semver';

export interface MigrationResult {
  success: boolean;
  originalVersion: string;
  targetVersion: string;
  changes: string[];
  warnings: string[];
  errors: string[];
  migratedWorkflow?: Workflow;
}

/**
 * Detects the version of a workflow
 */
export function detectWorkflowVersion(workflow: any): string {
  // Explicit version
  if (workflow.version) {
    return workflow.version;
  }
  
  // Check for loop features (v0.1.0+)
  if (workflow.steps?.some((step: any) => step.type === 'loop')) {
    return '0.1.0';
  }
  
  // Default to v0.0.1
  return '0.0.1';
}

/**
 * Migrates a workflow from v0.0.1 to v0.1.0
 */
export function migrateWorkflow(workflow: any): MigrationResult {
  const result: MigrationResult = {
    success: false,
    originalVersion: detectWorkflowVersion(workflow),
    targetVersion: '0.1.0',
    changes: [],
    warnings: [],
    errors: []
  };

  // Check if migration is needed
  if (semver.eq(result.originalVersion, result.targetVersion)) {
    result.success = true;
    result.warnings.push(`Workflow is already at version ${result.targetVersion}`);
    result.migratedWorkflow = workflow;
    return result;
  }

  if (semver.gt(result.originalVersion, result.targetVersion)) {
    result.errors.push(`Cannot downgrade from version ${result.originalVersion} to ${result.targetVersion}`);
    return result;
  }

  try {
    // Create a copy of the workflow
    const migrated = JSON.parse(JSON.stringify(workflow));
    
    // Apply v0.0.1 to v0.1.0 migration
    if (result.originalVersion === '0.0.1') {
      // Add version field
      if (!migrated.version) {
        migrated.version = '0.1.0';
        result.changes.push('Added version field: 0.1.0');
      }
      
      // Check for potential loop-like patterns in guidance
      if (migrated.steps) {
        migrated.steps.forEach((step: any, index: number) => {
          // Look for keywords that might indicate loop-like behavior
          const loopKeywords = ['repeat', 'iterate', 'loop', 'while', 'until', 'for each', 'foreach'];
          const prompt = (step.prompt || '').toLowerCase();
          const guidanceText = Array.isArray(step.guidance) 
            ? step.guidance.join(' ').toLowerCase() 
            : (step.guidance || '').toLowerCase();
          
          const hasLoopKeyword = loopKeywords.some(keyword => 
            prompt.includes(keyword) || guidanceText.includes(keyword)
          );
          
          if (hasLoopKeyword) {
            result.warnings.push(
              `Step '${step.id}' contains loop-related keywords. ` +
              `Consider refactoring to use the new loop feature.`
            );
          }
          
          // Look for manual iteration patterns (e.g., "Step 1 of N")
          const iterationPattern = /step\s+\d+\s+of\s+\d+/i;
          if (iterationPattern.test(step.prompt) || iterationPattern.test(guidanceText)) {
            result.warnings.push(
              `Step '${step.id}' appears to implement manual iteration. ` +
              `This could be simplified using a 'for' or 'forEach' loop.`
            );
          }
        });
      }
      
      // Ensure all required fields are present
      if (!migrated.id) {
        result.errors.push('Workflow must have an id');
      }
      if (!migrated.name) {
        result.errors.push('Workflow must have a name');
      }
      if (!migrated.steps || !Array.isArray(migrated.steps)) {
        result.errors.push('Workflow must have a steps array');
      }
    }
    
    // Validate the migrated workflow
    const validation = validateWorkflow(migrated);
    if (!validation.valid) {
      result.errors.push(...validation.errors);
      return result;
    }
    
    result.success = true;
    result.migratedWorkflow = migrated;
    
  } catch (error: any) {
    result.errors.push(`Migration failed: ${error.message}`);
  }
  
  return result;
}

/**
 * Migrates a workflow file and optionally writes the result
 */
export async function migrateWorkflowFile(
  inputPath: string,
  outputPath?: string,
  options: { dryRun?: boolean; backup?: boolean } = {}
): Promise<MigrationResult> {
  // Read the input file
  let content: string;
  try {
    content = await fs.promises.readFile(inputPath, 'utf-8');
  } catch (error: any) {
    return {
      success: false,
      originalVersion: 'unknown',
      targetVersion: '0.1.0',
      changes: [],
      warnings: [],
      errors: [`Failed to read file: ${error.message}`]
    };
  }
  
  // Parse the workflow
  let workflow: any;
  try {
    workflow = JSON.parse(content);
  } catch (error: any) {
    return {
      success: false,
      originalVersion: 'unknown',
      targetVersion: '0.1.0',
      changes: [],
      warnings: [],
      errors: [`Invalid JSON: ${error.message}`]
    };
  }
  
  // Perform migration
  const result = migrateWorkflow(workflow);
  
  if (result.success && result.migratedWorkflow && !options.dryRun) {
    // Determine output path
    const finalOutputPath = outputPath || inputPath;
    
    // Create backup if requested and overwriting
    if (options.backup && finalOutputPath === inputPath) {
      const backupPath = `${inputPath}.backup.${Date.now()}`;
      try {
        await fs.promises.copyFile(inputPath, backupPath);
        result.changes.push(`Created backup: ${path.basename(backupPath)}`);
      } catch (error: any) {
        result.warnings.push(`Failed to create backup: ${error.message}`);
      }
    }
    
    // Write the migrated workflow
    try {
      const output = JSON.stringify(result.migratedWorkflow, null, 2);
      await fs.promises.writeFile(finalOutputPath, output, 'utf-8');
      result.changes.push(`Wrote migrated workflow to: ${finalOutputPath}`);
    } catch (error: any) {
      result.errors.push(`Failed to write file: ${error.message}`);
      result.success = false;
    }
  }
  
  return result;
}

/**
 * CLI handler for migration command
 */
export async function handleMigrationCommand(
  filePath: string,
  options: {
    output?: string;
    dryRun?: boolean;
    backup?: boolean;
    quiet?: boolean;
  }
): Promise<void> {
  if (!options.quiet) {
    console.log(chalk.blue('🔄 Migrating workflow...'));
    console.log(chalk.gray(`Input: ${filePath}`));
    if (options.output) {
      console.log(chalk.gray(`Output: ${options.output}`));
    }
    if (options.dryRun) {
      console.log(chalk.yellow('⚠️  Dry run mode - no files will be modified'));
    }
  }
  
  const result = await migrateWorkflowFile(filePath, options.output, {
    dryRun: options.dryRun,
    backup: options.backup
  });
  
  if (!options.quiet) {
    console.log();
    
    // Show version info
    console.log(chalk.cyan('Version Information:'));
    console.log(`  Original: ${result.originalVersion}`);
    console.log(`  Target: ${result.targetVersion}`);
    console.log();
    
    // Show changes
    if (result.changes.length > 0) {
      console.log(chalk.green('✅ Changes made:'));
      result.changes.forEach(change => {
        console.log(chalk.green('  •'), change);
      });
      console.log();
    }
    
    // Show warnings
    if (result.warnings.length > 0) {
      console.log(chalk.yellow('⚠️  Warnings:'));
      result.warnings.forEach(warning => {
        console.log(chalk.yellow('  •'), warning);
      });
      console.log();
    }
    
    // Show errors
    if (result.errors.length > 0) {
      console.log(chalk.red('❌ Errors:'));
      result.errors.forEach(error => {
        console.log(chalk.red('  •'), error);
      });
      console.log();
    }
    
    // Final status
    if (result.success) {
      console.log(chalk.green('✅ Migration completed successfully!'));
    } else {
      console.log(chalk.red('❌ Migration failed!'));
      process.exit(1);
    }
  }
} 