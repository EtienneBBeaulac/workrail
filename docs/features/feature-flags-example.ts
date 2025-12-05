/**
 * Feature Flags Usage Examples
 * 
 * This file demonstrates clean architecture patterns for using feature flags
 * throughout the application.
 */

import { IFeatureFlagProvider } from '../../src/config/feature-flags.js';
import { initializeContainer, container } from '../../src/di/container.js';
import { DI } from '../../src/di/tokens.js';

// ============================================================================
// EXAMPLE 1: Service using feature flags (Dependency Injection)
// ============================================================================

/**
 * Example service that uses feature flags properly.
 * 
 * Best Practices:
 * - Inject IFeatureFlagProvider (don't import globally)
 * - Check flags at runtime, not at module load
 * - Provide fallback behavior when feature is disabled
 */
class ReportingService {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  async generateReport(bugId: string): Promise<string> {
    // Check feature flag before using advanced reporting
    if (this.featureFlags.isEnabled('sessionTools')) {
      return this.generateAdvancedReport(bugId);
    } else {
      return this.generateBasicReport(bugId);
    }
  }
  
  private async generateAdvancedReport(bugId: string): Promise<string> {
    // Use session tools to generate rich, interactive report
    return `Advanced report for ${bugId} with session data`;
  }
  
  private async generateBasicReport(bugId: string): Promise<string> {
    // Generate simple text report
    return `Basic report for ${bugId}`;
  }
}

// ============================================================================
// EXAMPLE 2: Factory pattern with feature flags
// ============================================================================

/**
 * Factory that creates different implementations based on feature flags.
 * 
 * This is useful when you have entirely different implementations
 * for a feature vs its fallback.
 */
interface IWorkflowLoader {
  loadWorkflows(): Promise<string[]>;
}

class StandardWorkflowLoader implements IWorkflowLoader {
  async loadWorkflows(): Promise<string[]> {
    return ['workflow1', 'workflow2', 'workflow3'];
  }
}

class ExperimentalWorkflowLoader implements IWorkflowLoader {
  async loadWorkflows(): Promise<string[]> {
    return [
      'workflow1',
      'workflow2',
      'workflow3',
      'experimental-workflow-1',
      'experimental-workflow-2',
    ];
  }
}

function createWorkflowLoader(featureFlags: IFeatureFlagProvider): IWorkflowLoader {
  if (featureFlags.isEnabled('experimentalWorkflows')) {
    return new ExperimentalWorkflowLoader();
  } else {
    return new StandardWorkflowLoader();
  }
}

// ============================================================================
// EXAMPLE 3: Conditional tool registration (like MCP server)
// ============================================================================

/**
 * Example of conditionally registering tools/handlers based on feature flags.
 * 
 * This pattern is used in the MCP server to enable/disable entire
 * tool suites.
 */
interface Tool {
  name: string;
  handler: () => void;
}

class ToolRegistry {
  private tools: Tool[] = [];
  
  constructor(private featureFlags: IFeatureFlagProvider) {
    this.registerTools();
  }
  
  private registerTools(): void {
    // Always register core tools
    this.tools.push({
      name: 'workflow_list',
      handler: () => console.log('Listing workflows'),
    });
    
    this.tools.push({
      name: 'workflow_get',
      handler: () => console.log('Getting workflow'),
    });
    
    // Conditionally register experimental tools
    if (this.featureFlags.isEnabled('sessionTools')) {
      this.tools.push({
        name: 'workrail_create_session',
        handler: () => console.log('Creating session'),
      });
      
      this.tools.push({
        name: 'workrail_update_session',
        handler: () => console.log('Updating session'),
      });
    }
  }
  
  getTools(): Tool[] {
    return this.tools;
  }
}

// ============================================================================
// EXAMPLE 4: Feature flag guards with helpful error messages
// ============================================================================

/**
 * Example of guarding feature usage with clear error messages.
 * 
 * Users get helpful feedback when they try to use a disabled feature.
 */
class DashboardService {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  async openDashboard(sessionId: string): Promise<void> {
    // Guard: Check if feature is enabled
    if (!this.featureFlags.isEnabled('sessionTools')) {
      throw new Error(
        'Dashboard feature is not enabled. ' +
        'Set WORKRAIL_ENABLE_SESSION_TOOLS=true to enable.'
      );
    }
    
    // Feature is enabled - proceed
    console.log(`Opening dashboard for session: ${sessionId}`);
  }
}

// ============================================================================
// EXAMPLE 5: Logging/telemetry controlled by feature flags
// ============================================================================

/**
 * Example of using feature flags to control logging verbosity.
 * 
 * This is useful for debugging in production without performance impact.
 */
class Logger {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  info(message: string): void {
    // Always log info
    console.log(`[INFO] ${message}`);
  }
  
  debug(message: string): void {
    // Only log debug if verbose logging is enabled
    if (this.featureFlags.isEnabled('verboseLogging')) {
      console.log(`[DEBUG] ${message}`);
    }
  }
  
  trace(message: string, data?: any): void {
    // Only log trace if verbose logging is enabled
    if (this.featureFlags.isEnabled('verboseLogging')) {
      console.log(`[TRACE] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
}

// ============================================================================
// EXAMPLE 6: Progressive feature rollout
// ============================================================================

/**
 * Example of progressively enabling features based on confidence levels.
 * 
 * This pattern is useful during stabilization phases.
 */
class ProgressiveFeatureService {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  async processWorkflow(workflowId: string): Promise<void> {
    // Phase 1: Stable features (always enabled)
    await this.validateWorkflow(workflowId);
    await this.executeWorkflow(workflowId);
    
    // Phase 2: Beta features (enabled with flag)
    if (this.featureFlags.isEnabled('sessionTools')) {
      await this.trackInSession(workflowId);
    }
    
    // Phase 3: Experimental features (enabled with flag)
    if (this.featureFlags.isEnabled('experimentalWorkflows')) {
      await this.applyAdvancedOptimizations(workflowId);
    }
    
    // Phase 4: Debug features (enabled with flag)
    if (this.featureFlags.isEnabled('verboseLogging')) {
      await this.generateDetailedReport(workflowId);
    }
  }
  
  private async validateWorkflow(id: string): Promise<void> {
    console.log(`Validating workflow: ${id}`);
  }
  
  private async executeWorkflow(id: string): Promise<void> {
    console.log(`Executing workflow: ${id}`);
  }
  
  private async trackInSession(id: string): Promise<void> {
    console.log(`Tracking workflow in session: ${id}`);
  }
  
  private async applyAdvancedOptimizations(id: string): Promise<void> {
    console.log(`Applying advanced optimizations: ${id}`);
  }
  
  private async generateDetailedReport(id: string): Promise<void> {
    console.log(`Generating detailed report: ${id}`);
  }
}

// ============================================================================
// EXAMPLE 7: Integration with dependency injection container
// ============================================================================

/**
 * Example of the complete pattern: container → services → feature flags
 */
async function main() {
  // 1. Initialize DI container (reads environment variables)
  await initializeContainer();
  
  // 2. Resolve feature flags from container
  const featureFlags = container.resolve<IFeatureFlagProvider>(DI.Infra.FeatureFlags);
  
  // 3. Inject feature flags into services
  const reportingService = new ReportingService(featureFlags);
  const dashboardService = new DashboardService(featureFlags);
  const logger = new Logger(featureFlags);
  
  // 4. Use services (they check feature flags internally)
  logger.info('Starting application');
  logger.debug('Debug mode enabled');
  
  reportingService.generateReport('BUG-123');
  
  try {
    dashboardService.openDashboard('SESSION-456');
  } catch (error) {
    logger.info(`Feature not available: ${error}`);
  }
  
  // 5. Log feature flag summary
  console.log('\n' + featureFlags.getSummary());
}

// ============================================================================
// ANTI-PATTERNS (DON'T DO THIS)
// ============================================================================

/* ❌ ANTI-PATTERN 1: Global import
 * 
 * Don't import feature flags globally - use dependency injection instead
 */

// ❌ BAD:
// import { createFeatureFlagProvider } from './config/feature-flags.js';
// const GLOBAL_FLAGS = createFeatureFlagProvider();
// 
// class BadService {
//   doSomething() {
//     if (GLOBAL_FLAGS.isEnabled('myFeature')) {
//       // Hard to test - global state
//     }
//   }
// }

// ✅ GOOD:
class GoodService {
  constructor(private featureFlags: IFeatureFlagProvider) {}
  
  doSomething() {
    if (this.featureFlags.isEnabled('myFeature')) {
      // Easy to test - injected dependency
    }
  }
}

/* ❌ ANTI-PATTERN 2: Magic strings
 * 
 * Don't use string literals - use the type-safe keys
 */

// ❌ BAD:
// if (featureFlags.isEnabled('sesionTools' as any)) { // Typo!
//   // ...
// }

// ✅ GOOD:
// if (featureFlags.isEnabled('sessionTools')) { // TypeScript catches typos
//   // ...
// }

/* ❌ ANTI-PATTERN 3: Feature detection instead of feature flags
 * 
 * Don't check if objects exist - use explicit feature flags
 */

// ❌ BAD:
// if (this.sessionManager) {
//   // Unclear why it might be undefined
// }

// ✅ GOOD:
// if (this.featureFlags.isEnabled('sessionTools')) {
//   // Clear that it's a feature flag
// }

/* ❌ ANTI-PATTERN 4: No fallback behavior
 * 
 * Always provide fallback when feature is disabled
 */

// ❌ BAD:
// if (featureFlags.isEnabled('myFeature')) {
//   doAdvancedThing();
// }
// // Nothing happens if disabled - silent failure

// ✅ GOOD:
// if (featureFlags.isEnabled('myFeature')) {
//   doAdvancedThing();
// } else {
//   doBasicThing(); // Clear fallback
// }

// ============================================================================
// Export examples for documentation
// ============================================================================

export {
  ReportingService,
  createWorkflowLoader,
  ToolRegistry,
  DashboardService,
  Logger,
  ProgressiveFeatureService,
  GoodService,
};

