import { 
  ContextLayer, 
  ClassificationRules, 
  ClassificationPattern, 
  ClassificationHeuristics,
  ClassifiedContext, 
  RawContext 
} from '../../types/context-types';

/**
 * Interface for context classification engine
 */
export interface IClassificationEngine {
  /**
   * Classify raw context into layered structure
   */
  classify(context: RawContext, rules?: ClassificationRules): Promise<ClassifiedContext>;

  /**
   * Load classification rules from configuration
   */
  loadRules(config?: Partial<ClassificationRules>): Promise<void>;

  /**
   * Add manual override for specific context key
   */
  addOverride(sessionId: string, contextKey: string, layer: ContextLayer): void;

  /**
   * Remove manual override for specific context key
   */
  removeOverride(sessionId: string, contextKey: string): void;

  /**
   * Get current classification statistics
   */
  getStats(): ClassificationStats;
}

/**
 * Statistics for classification operations
 */
export interface ClassificationStats {
  totalClassifications: number;
  layerDistribution: Record<ContextLayer, number>;
  overrideCount: number;
  averageProcessingTime: number;
}

/**
 * Context classification engine using pattern matching and heuristics
 * 
 * This engine classifies context data into four layers (CRITICAL, IMPORTANT, USEFUL, EPHEMERAL)
 * based on configurable patterns and content heuristics. Supports agent overrides for dynamic
 * classification adjustments during workflow execution.
 */
export class ClassificationEngine implements IClassificationEngine {
  private rules: ClassificationRules;
  private overrides: Map<string, Map<string, ContextLayer>> = new Map(); // sessionId -> contextKey -> layer
  private stats: ClassificationStats;

  constructor(initialRules?: ClassificationRules) {
    this.rules = initialRules || this.getDefaultRules();
    this.stats = {
      totalClassifications: 0,
      layerDistribution: {
        [ContextLayer.CRITICAL]: 0,
        [ContextLayer.IMPORTANT]: 0,
        [ContextLayer.USEFUL]: 0,
        [ContextLayer.EPHEMERAL]: 0
      },
      overrideCount: 0,
      averageProcessingTime: 0
    };
  }

  /**
   * Classify raw context into layered structure based on patterns and heuristics
   */
  async classify(context: RawContext, rules?: ClassificationRules): Promise<ClassifiedContext> {
    const startTime = process.hrtime.bigint();
    const activeRules = rules || this.rules;

    const classified: ClassifiedContext = {
      [ContextLayer.CRITICAL]: {},
      [ContextLayer.IMPORTANT]: {},
      [ContextLayer.USEFUL]: {},
      [ContextLayer.EPHEMERAL]: {}
    };

    // Process each context key-value pair
    for (const [key, value] of Object.entries(context)) {
      const layer = this.classifyKeyValue(key, value, activeRules);
      classified[layer][key] = value;
    }

    // Update statistics
    this.updateStats(startTime, classified);

    return Object.freeze(classified) as ClassifiedContext;
  }

  /**
   * Load classification rules from configuration
   */
  async loadRules(config?: Partial<ClassificationRules>): Promise<void> {
    if (config) {
      this.rules = {
        patterns: { ...this.rules.patterns, ...config.patterns },
        heuristics: { ...this.rules.heuristics, ...config.heuristics },
        overrides: { ...this.rules.overrides, ...config.overrides }
      };
    }
  }

  /**
   * Add manual override for specific context key
   */
  addOverride(sessionId: string, contextKey: string, layer: ContextLayer): void {
    if (!this.overrides.has(sessionId)) {
      this.overrides.set(sessionId, new Map());
    }
    
    const sessionOverrides = this.overrides.get(sessionId)!;
    sessionOverrides.set(contextKey, layer);
    this.stats.overrideCount++;
  }

  /**
   * Remove manual override for specific context key
   */
  removeOverride(sessionId: string, contextKey: string): void {
    const sessionOverrides = this.overrides.get(sessionId);
    if (sessionOverrides && sessionOverrides.has(contextKey)) {
      sessionOverrides.delete(contextKey);
      this.stats.overrideCount = Math.max(0, this.stats.overrideCount - 1);
      
      // Clean up empty session maps
      if (sessionOverrides.size === 0) {
        this.overrides.delete(sessionId);
      }
    }
  }

  /**
   * Get current classification statistics
   */
  getStats(): ClassificationStats {
    return { ...this.stats };
  }

  /**
   * Classify a single key-value pair
   */
  private classifyKeyValue(key: string, value: any, rules: ClassificationRules, sessionId?: string): ContextLayer {
    // Check for manual overrides first
    if (sessionId) {
      const sessionOverrides = this.overrides.get(sessionId);
      const override = sessionOverrides?.get(key);
      if (override) {
        return override;
      }
    }

    // Check global overrides in rules
    if (rules.overrides[key]) {
      return rules.overrides[key];
    }

    // Apply pattern-based classification
    const patternLayer = this.applyPatternMatching(key, value, rules);
    if (patternLayer) {
      return patternLayer;
    }

    // Apply heuristic-based classification
    return this.applyHeuristics(key, value, rules);
  }

  /**
   * Apply pattern-based classification rules
   */
  private applyPatternMatching(key: string, value: any, rules: ClassificationRules): ContextLayer | null {
    let bestMatch: { layer: ContextLayer; weight: number } | null = null;

    // Check patterns for each layer, prioritizing by weight
    for (const [layer, patterns] of Object.entries(rules.patterns)) {
      for (const pattern of patterns) {
        if (this.matchesPattern(key, value, pattern)) {
          if (!bestMatch || pattern.weight > bestMatch.weight) {
            bestMatch = { layer: layer as ContextLayer, weight: pattern.weight };
          }
        }
      }
    }

    return bestMatch?.layer || null;
  }

  /**
   * Check if key-value pair matches a classification pattern
   */
  private matchesPattern(key: string, value: any, pattern: ClassificationPattern): boolean {
    // Check key pattern
    const keyRegex = new RegExp(pattern.keyPattern, 'i');
    if (!keyRegex.test(key)) {
      return false;
    }

    // Check value pattern if specified
    if (pattern.valuePattern) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const valueRegex = new RegExp(pattern.valuePattern, 'i');
      if (!valueRegex.test(valueStr)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Apply heuristic-based classification
   */
  private applyHeuristics(key: string, value: any, rules: ClassificationRules): ContextLayer {
    const heuristics = rules.heuristics;
    const valueStr = typeof value === 'string' ? value : 
                     value === undefined ? 'undefined' :
                     value === null ? 'null' :
                     JSON.stringify(value);
    const contentLength = valueStr.length;

    // Check keyword weights
    let keywordScore = 0;
    for (const [keyword, weight] of Object.entries(heuristics.keywordWeights)) {
      const regex = new RegExp(keyword, 'gi');
      const matches = (key + ' ' + valueStr).match(regex);
      if (matches) {
        keywordScore += matches.length * weight;
      }
    }

    // Determine layer based on content length and keyword score
    if (keywordScore >= 10 || contentLength >= heuristics.lengthThresholds[ContextLayer.CRITICAL]) {
      return ContextLayer.CRITICAL;
    } else if (keywordScore >= 5 || contentLength >= heuristics.lengthThresholds[ContextLayer.IMPORTANT]) {
      return ContextLayer.IMPORTANT;
    } else if (contentLength >= heuristics.lengthThresholds[ContextLayer.USEFUL]) {
      return ContextLayer.USEFUL;
    } else {
      return heuristics.defaultLayer;
    }
  }

  /**
   * Update classification statistics
   */
  private updateStats(startTime: bigint, classified: ClassifiedContext): void {
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1000000; // Convert nanoseconds to milliseconds
    
    // Update averages
    this.stats.totalClassifications++;
    this.stats.averageProcessingTime = 
      (this.stats.averageProcessingTime * (this.stats.totalClassifications - 1) + processingTime) / 
      this.stats.totalClassifications;

    // Update layer distribution
    for (const [layer, content] of Object.entries(classified)) {
      const itemCount = Object.keys(content).length;
      this.stats.layerDistribution[layer as ContextLayer] += itemCount;
    }
  }

  /**
   * Get default classification rules
   */
  private getDefaultRules(): ClassificationRules {
    return {
      patterns: {
        [ContextLayer.CRITICAL]: [
          {
            keyPattern: '^(goal|objective|target|requirement|result|answer|decision|conclusion)s?$',
            weight: 100,
            description: 'Core workflow objectives and final results'
          },
          {
            keyPattern: '^(user|customer|client).*',
            weight: 90,
            description: 'User-related information and requirements'
          },
          {
            keyPattern: '^(error|failure|critical|urgent|important).*',
            weight: 85,
            description: 'Critical errors and urgent items'
          }
        ],
        [ContextLayer.IMPORTANT]: [
          {
            keyPattern: '^(plan|strategy|approach|method|process|workflow)s?$',
            weight: 80,
            description: 'Planning and strategic information'
          },
          {
            keyPattern: '^(config|settings|parameters).*',
            weight: 70,
            description: 'Configuration and settings'
          },
          {
            keyPattern: '^(state|status|progress).*',
            weight: 65,
            description: 'Current state and progress tracking'
          }
        ],
        [ContextLayer.USEFUL]: [
          {
            keyPattern: '^(data|content|information|details).*',
            weight: 50,
            description: 'Supporting data and detailed information'
          },
          {
            keyPattern: '^(example|sample|demo)s?.*',
            weight: 45,
            description: 'Examples and demonstrations'
          },
          {
            keyPattern: '^(analysis|report|summary).*',
            weight: 40,
            description: 'Analysis results and reports'
          }
        ],
        [ContextLayer.EPHEMERAL]: [
          {
            keyPattern: '^(temp|temporary|cache|buffer).*',
            weight: 20,
            description: 'Temporary data and cache'
          },
          {
            keyPattern: '.*(debug|log|trace|timestamp).*',
            weight: 15,
            description: 'Debug information and logs'
          },
          {
            keyPattern: '^(_|internal).*',
            weight: 10,
            description: 'Internal system metadata'
          }
        ]
      },
      heuristics: {
        lengthThresholds: {
          [ContextLayer.CRITICAL]: 1000,   // Long critical content
          [ContextLayer.IMPORTANT]: 500,   // Medium important content
          [ContextLayer.USEFUL]: 100,      // Short useful content
          [ContextLayer.EPHEMERAL]: 0      // Any length ephemeral
        },
        keywordWeights: {
          'goal': 15,
          'objective': 15,
          'requirement': 12,
          'critical': 10,
          'important': 8,
          'urgent': 8,
          'user': 7,
          'error': 7,
          'failure': 7,
          'plan': 6,
          'strategy': 6,
          'config': 5,
          'data': 3,
          'example': 2,
          'debug': 1,
          'temp': 1
        },
        defaultLayer: ContextLayer.USEFUL
      },
      overrides: {}
    };
  }
} 