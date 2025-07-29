import * as crypto from 'crypto';
import {
  IContextPersistenceService,
  IClassificationEngine,
  ICompressionService,
  RawContext,
  ClassifiedContext,
  PersistableContext,
  CompressedBlob,
  ContextLayer,
  CompressionStats,
  CheckpointMetadata,
  SessionInfo
} from '../../types/context-types';

/**
 * Default session ID derivation configuration
 */
const SESSION_ID_CONFIG = {
  algorithm: 'sha256' as const,
  encoding: 'hex' as const,
  maxLength: 32 // Truncate to 32 characters for readability
};

/**
 * Performance metrics for persistence operations
 */
interface PersistenceMetrics {
  totalOperations: number;
  averageClassificationTime: number;
  averageCompressionTime: number;
  averageTotalTime: number;
  lastOperationTime: number;
  compressionStats: CompressionStats;
}

/**
 * ContextPersistenceService implements the core persistence logic pipeline
 * 
 * This service orchestrates the complete context processing workflow:
 * 1. Context classification using ClassificationEngine
 * 2. Layer-specific compression using CompressionService  
 * 3. Session ID generation using hash-based derivation
 * 4. Performance monitoring and metrics tracking
 * 
 * Features:
 * - Immutable data handling throughout the pipeline
 * - High-precision performance timing
 * - Configurable session ID generation strategies
 * - Comprehensive error handling with graceful degradation
 * - Integration with existing ClassificationEngine and CompressionService
 */
export class ContextPersistenceService implements IContextPersistenceService {
  private metrics: PersistenceMetrics;

  constructor(
    private readonly classificationEngine: IClassificationEngine,
    private readonly compressionService: ICompressionService
  ) {
    this.metrics = {
      totalOperations: 0,
      averageClassificationTime: 0,
      averageCompressionTime: 0,
      averageTotalTime: 0,
      lastOperationTime: 0,
      compressionStats: {
        totalOperations: 0,
        averageRatio: 1.0,
        totalSizeReduction: 0,
        averageCompressionTime: 0
      }
    };
  }

  /**
   * Classify raw context into importance layers
   */
  async classifyContext(context: RawContext): Promise<ClassifiedContext> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Ensure immutable input handling
      const frozenContext = Object.freeze({ ...context });
      
      // Perform classification (now async)
      const classified = await this.classificationEngine.classify(frozenContext);
      
      // Ensure classified result is immutable
      const immutableClassified: ClassifiedContext = {
        [ContextLayer.CRITICAL]: Object.freeze({ ...classified[ContextLayer.CRITICAL] }),
        [ContextLayer.IMPORTANT]: Object.freeze({ ...classified[ContextLayer.IMPORTANT] }),
        [ContextLayer.USEFUL]: Object.freeze({ ...classified[ContextLayer.USEFUL] }),
        [ContextLayer.EPHEMERAL]: Object.freeze({ ...classified[ContextLayer.EPHEMERAL] })
      };
      
      // Update metrics
      const endTime = process.hrtime.bigint();
      const classificationTime = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
      this.updateClassificationMetrics(classificationTime);
      
      return Object.freeze(immutableClassified) as ClassifiedContext;
      
    } catch (error) {
      console.error('Context classification failed:', error);
      // Graceful fallback: put all context in IMPORTANT layer
      return this.createFallbackClassification(context);
    }
  }

  /**
   * Compress classified context using layer-specific strategies
   */
  async compressContext(classified: ClassifiedContext): Promise<CompressedBlob> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Ensure immutable input
      const frozenClassified = Object.freeze({ ...classified });
      
      // Perform compression
      const compressed = await this.compressionService.compress(frozenClassified);
      
      // Update metrics
      const endTime = process.hrtime.bigint();
      const compressionTime = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
      this.updateCompressionMetrics(compressionTime);
      
      return compressed;
      
    } catch (error) {
      console.error('Context compression failed:', error);
      // Graceful fallback: create uncompressed blob
      return this.createUncompressedBlob(classified);
    }
  }

  /**
   * Decompress blob back to raw context
   */
  async decompressContext(compressed: CompressedBlob): Promise<RawContext> {
    try {
      const decompressed = await this.compressionService.decompress(compressed);
      
      // Ensure result is immutable
      return Object.freeze({ ...decompressed }) as RawContext;
      
    } catch (error) {
      console.error('Context decompression failed:', error);
      throw new Error(`Failed to decompress context: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate session ID using hash-based derivation
   * Strategy: hash(workflowId + initialContextHash) with fallbacks
   */
  generateSessionId(workflowId: string, context: RawContext): string {
    try {
      // Create deterministic hash input
      const contextString = JSON.stringify(context, Object.keys(context).sort());
      const contextHash = crypto
        .createHash(SESSION_ID_CONFIG.algorithm)
        .update(contextString)
        .digest(SESSION_ID_CONFIG.encoding);
      
      // Combine workflow ID and context hash
      const combinedInput = `${workflowId}:${contextHash}`;
      const sessionHash = crypto
        .createHash(SESSION_ID_CONFIG.algorithm)
        .update(combinedInput)
        .digest(SESSION_ID_CONFIG.encoding);
      
      // Truncate to manageable length and ensure valid format
      const sessionId = sessionHash.substring(0, SESSION_ID_CONFIG.maxLength);
      
      // Validate session ID format (alphanumeric + dashes)
      if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
        throw new Error('Generated session ID contains invalid characters');
      }
      
      return sessionId;
      
    } catch (error) {
      console.warn('Session ID generation failed, using fallback:', error);
      // Fallback: use timestamp-based ID
      return this.generateFallbackSessionId(workflowId);
    }
  }

  /**
   * Execute the complete persistence pipeline
   * workflow context → classification → compression → ready for storage
   */
  async processPersistencePipeline(
    context: RawContext,
    workflowId: string
  ): Promise<{
    sessionId: string;
    classified: ClassifiedContext;
    compressed: CompressedBlob;
    metrics: {
      classificationTime: number;
      compressionTime: number;
      totalTime: number;
    };
  }> {
    const pipelineStartTime = process.hrtime.bigint();
    
    try {
      // Step 1: Generate session ID
      const sessionId = this.generateSessionId(workflowId, context);
      
      // Step 2: Classify context
      const classificationStart = process.hrtime.bigint();
      const classified = await this.classifyContext(context);
      const classificationEnd = process.hrtime.bigint();
      const classificationTime = Number(classificationEnd - classificationStart) / 1_000_000;
      
      // Step 3: Compress classified context
      const compressionStart = process.hrtime.bigint();
      const compressed = await this.compressContext(classified);
      const compressionEnd = process.hrtime.bigint();
      const compressionTime = Number(compressionEnd - compressionStart) / 1_000_000;
      
      // Calculate total pipeline time
      const pipelineEndTime = process.hrtime.bigint();
      const totalTime = Number(pipelineEndTime - pipelineStartTime) / 1_000_000;
      
      // Update overall metrics
      this.updatePipelineMetrics(totalTime);
      
      return {
        sessionId,
        classified: Object.freeze(classified) as ClassifiedContext,
        compressed,
        metrics: {
          classificationTime,
          compressionTime,
          totalTime
        }
      };
      
    } catch (error) {
      console.error('Persistence pipeline failed:', error);
      throw new Error(`Persistence pipeline error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute the complete restoration pipeline  
   * compressed blob → decompression → ready for use
   */
  async processRestorationPipeline(compressed: CompressedBlob): Promise<{
    context: RawContext;
    metrics: {
      decompressionTime: number;
    };
  }> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Decompress the context
      const context = await this.decompressContext(compressed);
      
      const endTime = process.hrtime.bigint();
      const decompressionTime = Number(endTime - startTime) / 1_000_000;
      
      return {
        context: Object.freeze(context) as RawContext,
        metrics: {
          decompressionTime
        }
      };
      
    } catch (error) {
      console.error('Restoration pipeline failed:', error);
      throw new Error(`Restoration pipeline error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PersistenceMetrics {
    // Get latest compression stats
    const latestCompressionStats = this.compressionService.getStats();
    
    return {
      ...this.metrics,
      compressionStats: { ...latestCompressionStats }
    };
  }

  /**
   * Reset performance metrics (useful for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      totalOperations: 0,
      averageClassificationTime: 0,
      averageCompressionTime: 0,
      averageTotalTime: 0,
      lastOperationTime: 0,
      compressionStats: {
        totalOperations: 0,
        averageRatio: 1.0,
        totalSizeReduction: 0,
        averageCompressionTime: 0
      }
    };
    
    // Also reset compression service metrics (cast to access resetStats)
    (this.compressionService as any).resetStats?.();
  }

  // Required interface methods from IContextPersistenceService

  /**
   * Persist context with classification and compression
   * Note: This is a placeholder implementation - actual storage is handled by ContextManagementService
   */
  async persistContext(sessionId: string, context: RawContext, metadata?: Partial<CheckpointMetadata>): Promise<CheckpointMetadata> {
    throw new Error('persistContext not implemented - use processPersistencePipeline for core logic');
  }

  /**
   * Restore context from storage
   * Note: This is a placeholder implementation - actual storage is handled by ContextManagementService
   */
  async restoreContext(checkpointId: string): Promise<RawContext> {
    throw new Error('restoreContext not implemented - use processRestorationPipeline for core logic');
  }

  /**
   * Get session information
   * Note: This is a placeholder implementation - actual storage is handled by ContextManagementService
   */
  async getSession(sessionId: string): Promise<SessionInfo> {
    throw new Error('getSession not implemented - handled by ContextManagementService');
  }

  // Private helper methods

  private createFallbackClassification(context: RawContext): ClassifiedContext {
    // Create a safe fallback classification
    const safeContext = { ...context };
    
    return Object.freeze({
      [ContextLayer.CRITICAL]: {},
      [ContextLayer.IMPORTANT]: Object.freeze(safeContext),
      [ContextLayer.USEFUL]: {},
      [ContextLayer.EPHEMERAL]: {}
    }) as ClassifiedContext;
  }

  private async createUncompressedBlob(classified: ClassifiedContext): Promise<CompressedBlob> {
    // Flatten the classified context back to raw format
    const flattened: RawContext = {};
    
    for (const [layer, data] of Object.entries(classified)) {
      Object.assign(flattened, data);
    }
    
    const serialized = JSON.stringify(flattened);
    const data = Buffer.from(serialized, 'utf8');
    const size = data.length;
    
    return {
      data,
      originalSize: size,
      compressedSize: size,
      compressionRatio: 1.0,
      algorithm: 'none'
    };
  }

  private generateFallbackSessionId(workflowId: string): string {
    const timestamp = Date.now().toString(36);
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const fallbackId = `${workflowId}-${timestamp}-${randomSuffix}`;
    
    // Ensure it meets length constraints
    return fallbackId.substring(0, SESSION_ID_CONFIG.maxLength);
  }

  private updateClassificationMetrics(classificationTime: number): void {
    const prevOps = this.metrics.totalOperations;
    this.metrics.totalOperations += 1;
    this.metrics.averageClassificationTime = 
      (this.metrics.averageClassificationTime * prevOps + classificationTime) / this.metrics.totalOperations;
    this.metrics.lastOperationTime = Date.now();
  }

  private updateCompressionMetrics(compressionTime: number): void {
    const prevOps = this.metrics.totalOperations || 1; // Avoid division by zero
    this.metrics.averageCompressionTime = 
      (this.metrics.averageCompressionTime * (prevOps - 1) + compressionTime) / prevOps;
  }

  private updatePipelineMetrics(totalTime: number): void {
    const prevOps = this.metrics.totalOperations || 1; // Avoid division by zero
    this.metrics.averageTotalTime = 
      (this.metrics.averageTotalTime * (prevOps - 1) + totalTime) / prevOps;
  }
} 