/**
 * Pattern Recognizer
 * 
 * Detects structural patterns in session data and maps them to appropriate
 * UI components. This is the core of the generic dashboard system.
 * 
 * Key principle: Recognize data SHAPES, not domain-specific field names.
 */

import { intentAnalyzer } from './intent-analyzer.js';
import { chartBuilder } from './chart-builder.js';
import { memoize } from '../utils/performance.js';

/**
 * Component specification returned by pattern recognition
 * @typedef {Object} ComponentSpec
 * @property {string} component - Component name to render
 * @property {Object} props - Props to pass to component
 * @property {number} priority - Priority for conflict resolution (higher = more specific)
 */

export class PatternRecognizer {
  constructor() {
    this.intentAnalyzer = intentAnalyzer;
    this.chartBuilder = chartBuilder;
    
    // Memoize formatLabel for performance
    this.formatLabel = memoize(this._formatLabel.bind(this), { maxSize: 100 });
  }
  
  /**
   * Recognize pattern and return component specification
   * @param {string} key - Field name
   * @param {any} value - Field value
   * @returns {ComponentSpec}
   */
  recognize(key, value) {
    try {
      // Validate inputs
      if (key == null) {
        console.warn('PatternRecognizer: null/undefined key provided');
        return this.emptyComponent('Invalid Field');
      }
      
      // Ensure key is string
      if (typeof key !== 'string') {
        console.warn(`PatternRecognizer: non-string key provided: ${typeof key}`);
        key = String(key);
      }
      
      // Check for circular references
      if (this.hasCircularReference(value)) {
        console.warn(`PatternRecognizer: circular reference detected in ${key}`);
        return this.errorComponent(key, 'Circular reference detected');
      }
      
      // Analyze intent for better field understanding
      try {
        const intent = this.intentAnalyzer.analyzeIntent(key, value);
        if (intent.canonical && intent.canonical !== key && intent.confidence >= 0.7) {
          console.log(`💡 Field suggestion: '${key}' → '${intent.canonical}' (${Math.round(intent.confidence * 100)}% match)`);
        }
      } catch (intentError) {
        console.warn('Intent analysis error:', intentError);
        // Continue with normal recognition
      }
      
      // Priority 0: Special reserved field
      if (key === 'dashboard') {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return {
            component: 'Hero',
            props: value,
            priority: 100
          };
        }
        console.warn('Dashboard field is not an object, rendering as card');
        return {
          component: 'Card',
          props: { title: 'Dashboard', data: value },
          priority: 100
        };
      }
      
      // Null/undefined
      if (value === null || value === undefined) {
        return {
          component: 'Empty',
          props: { label: this.formatLabel(key) },
          priority: 0
        };
      }
      
      // Arrays
      if (Array.isArray(value)) {
        return this.recognizeArray(key, value);
      }
      
      // Objects
      if (typeof value === 'object') {
        return this.recognizeObject(key, value);
      }
      
      // Primitives
      return this.recognizePrimitive(key, value);
      
    } catch (error) {
      console.error(`PatternRecognizer: Error recognizing pattern for "${key}":`, error);
      return this.errorComponent(key, error.message);
    }
  }
  
  /**
   * Check for circular references
   * @private
   */
  hasCircularReference(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
      return false;
    }
    
    if (seen.has(value)) {
      return true;
    }
    
    seen.add(value);
    
    try {
      if (Array.isArray(value)) {
        return value.some(item => this.hasCircularReference(item, seen));
      }
      
      return Object.values(value).some(val => this.hasCircularReference(val, seen));
    } catch (e) {
      // If we can't traverse, assume no circular reference
      return false;
    }
  }
  
  /**
   * Create empty component spec
   * @private
   */
  emptyComponent(label) {
    return {
      component: 'Empty',
      props: { label },
      priority: 0
    };
  }
  
  /**
   * Create error component spec
   * @private
   */
  errorComponent(key, message) {
    return {
      component: 'ErrorCard',
      props: {
        title: this.formatLabel(key),
        error: message,
        details: 'Unable to determine how to display this data'
      },
      priority: 0
    };
  }
  
  /**
   * Recognize array patterns
   * @private
   */
  recognizeArray(key, value) {
    try {
      // Empty array
      if (!Array.isArray(value) || value.length === 0) {
        return {
          component: 'EmptyCard',
          props: { 
            message: `No ${this.formatLabel(key).toLowerCase()} yet`,
            icon: 'inbox'
          },
          priority: 10
        };
      }
      
      // Filter out null/undefined items
      const validItems = value.filter(item => item != null);
      
      if (validItems.length === 0) {
        return {
          component: 'EmptyCard',
          props: { 
            message: `No valid ${this.formatLabel(key).toLowerCase()}`,
            icon: 'inbox'
          },
          priority: 10
        };
      }
      
      const first = validItems[0];
      
      // Priority 95: Chart data (array with label + value)
      if (first?.label !== undefined && first?.value !== undefined && typeof first.value === 'number') {
        // Determine chart type based on key name or data characteristics
        const keyLower = key.toLowerCase();
        let chartType = 'bar'; // default
        
        if (keyLower.includes('trend') || keyLower.includes('over-time') || keyLower.includes('history')) {
          chartType = 'line';
        } else if (keyLower.includes('distribution') || keyLower.includes('breakdown') || keyLower.includes('share')) {
          chartType = 'pie';
        }
        
        return {
          component: 'Chart',
          props: {
            type: chartType,
            data: validItems,
            title: this.formatLabel(key)
          },
          priority: 95
        };
      }
    
      // Priority 90: Array with severity (critical/warning/info)
      if (first?.severity !== undefined) {
        return {
          component: 'SeverityList',
          props: {
            title: this.formatLabel(key),
            items: validItems,
            severityField: 'severity'
          },
          priority: 90
        };
      }
      
      // Priority 90: Array with timestamp (timeline)
      if (first?.timestamp !== undefined && this.isTimestamp(first.timestamp)) {
        return {
          component: 'Timeline',
          props: {
            title: this.formatLabel(key),
            events: validItems
          },
          priority: 90
        };
      }
      
      // Priority 80: Array with status (active/pending/complete)
      if (first?.status !== undefined) {
        return {
          component: 'GroupedList',
          props: {
            title: this.formatLabel(key),
            items: validItems,
            groupBy: 'status',
            groupOrder: ['active', 'in-progress', 'pending', 'testing', 'confirmed', 'partial', 'complete', 'rejected', 'ruled-out', 'failed', 'cancelled']
          },
          priority: 80
        };
      }
    
      // Priority 70: Array with priority
      if (first?.priority !== undefined) {
        return {
          component: 'PriorityList',
          props: {
            title: this.formatLabel(key),
            items: validItems,
            priorityField: 'priority'
          },
          priority: 70
        };
      }
      
      // Priority 70: Array with category
      if (first?.category !== undefined) {
        return {
          component: 'GroupedList',
          props: {
            title: this.formatLabel(key),
            items: validItems,
            groupBy: 'category'
          },
          priority: 70
        };
      }
      
      // Priority 60: Array of strings
      if (typeof first === 'string') {
        return {
          component: 'Checklist',
          props: {
            title: this.formatLabel(key),
            items: validItems
          },
          priority: 60
        };
      }
      
      // Priority 60: Array of numbers
      if (typeof first === 'number') {
        return {
          component: 'NumberList',
          props: {
            title: this.formatLabel(key),
            numbers: validItems
          },
          priority: 60
        };
      }
      
      // Priority 20: Array of objects (generic)
      if (typeof first === 'object') {
        return {
          component: 'List',
          props: {
            title: this.formatLabel(key),
            items: validItems
          },
          priority: 20
        };
      }
      
      // Fallback
      return {
        component: 'List',
        props: {
          title: this.formatLabel(key),
          items: validItems
        },
        priority: 10
      };
      
    } catch (error) {
      console.error(`Error recognizing array pattern for "${key}":`, error);
      return this.errorComponent(key, `Array processing error: ${error.message}`);
    }
  }
  
  /**
   * Recognize object patterns
   * @private
   */
  recognizeObject(key, value) {
    try {
      // Validate object
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        console.warn(`recognizeObject called with non-object for "${key}"`);
        return this.errorComponent(key, 'Expected object, got ' + typeof value);
      }
      
      const values = Object.values(value);
      const keys = Object.keys(value);
    
    // Priority 90: Object with high confidence (≥8.0)
    if (typeof value.confidence === 'number' && value.confidence >= 8.0) {
      return {
        component: 'HighlightCard',
        props: {
          title: this.formatLabel(key),
          data: value,
          confidence: value.confidence
        },
        priority: 90
      };
    }
    
    // Priority 80: Object with before/after (diff)
    if (value.before !== undefined && value.after !== undefined) {
      return {
        component: 'DiffViewer',
        props: {
          title: this.formatLabel(key),
          before: value.before,
          after: value.after
        },
        priority: 80
      };
    }
    
    // Priority 80: Object with all numbers (metrics/stats)
    if (values.length > 0 && values.every(v => typeof v === 'number')) {
      return {
        component: 'StatGrid',
        props: {
          title: this.formatLabel(key),
          metrics: value,
          columns: Math.min(4, keys.length)
        },
        priority: 80
      };
    }
    
    // Priority 70: Object with error field
    if (value.error !== undefined) {
      return {
        component: 'ErrorCard',
        props: {
          title: this.formatLabel(key),
          error: value.error,
          code: value.code,
          details: value.details
        },
        priority: 70
      };
    }
    
    // Priority 35: Phases collection (special case for workflow phases)
    if (key === 'phases' && typeof value === 'object') {
      return {
        component: 'PhasesList',
        props: {
          title: this.formatLabel(key),
          phases: value
        },
        priority: 35
      };
    }
    
    // Priority 30: Object collection (object whose values are all objects)
    // Example: { metadata: { "item-1": {...}, "item-2": {...} } }
    const collectionValues = Object.values(value);
    const allValuesAreObjects = collectionValues.length > 0 && 
      collectionValues.every(v => v !== null && typeof v === 'object' && !Array.isArray(v));
    
    if (allValuesAreObjects) {
      return {
        component: 'ObjectCollection',
        props: {
          title: this.formatLabel(key),
          items: value
        },
        priority: 30
      };
    }
    
      // Priority 20: Generic nested object
      return {
        component: 'Card',
        props: {
          title: this.formatLabel(key),
          data: value
        },
        priority: 20
      };
      
    } catch (error) {
      console.error(`Error recognizing object pattern for "${key}":`, error);
      return this.errorComponent(key, `Object processing error: ${error.message}`);
    }
  }
  
  /**
   * Recognize primitive patterns
   * @private
   */
  recognizePrimitive(key, value) {
    try {
      // Numbers
      if (typeof value === 'number') {
        // Validate number
        if (!Number.isFinite(value)) {
          return {
            component: 'TextField',
            props: {
              label: this.formatLabel(key),
              text: String(value)
            },
            priority: 30
          };
        }
      // Priority 80: Score (0-10 range)
      if (value >= 0 && value <= 10) {
        return {
          component: 'ScoreDisplay',
          props: {
            label: this.formatLabel(key),
            score: value,
            maxScore: 10
          },
          priority: 80
        };
      }
      
      // Priority 80: Progress (0-100 range)
      if (value >= 0 && value <= 100 && this.looksLikeProgress(key)) {
        return {
          component: 'ProgressBar',
          props: {
            label: this.formatLabel(key),
            value: value,
            max: 100
          },
          priority: 80
        };
      }
      
      // Priority 40: Generic number
      return {
        component: 'StatCard',
        props: {
          label: this.formatLabel(key),
          value: value
        },
        priority: 40
      };
    }
    
    // Strings
    if (typeof value === 'string') {
      // Priority 80: Timestamp
      if (this.isTimestamp(value)) {
        return {
          component: 'TimeDisplay',
          props: {
            label: this.formatLabel(key),
            timestamp: value
          },
          priority: 80
        };
      }
      
      // Priority 70: URL
      if (this.isUrl(value)) {
        return {
          component: 'LinkText',
          props: {
            label: this.formatLabel(key),
            url: value
          },
          priority: 70
        };
      }
      
      // Priority 70: File path
      if (this.isFilePath(value)) {
        return {
          component: 'PathText',
          props: {
            label: this.formatLabel(key),
            path: value
          },
          priority: 70
        };
      }
      
      // Priority 60: Code
      if (this.looksLikeCode(value)) {
        return {
          component: 'CodeBlock',
          props: {
            title: this.formatLabel(key),
            code: value,
            language: this.inferLanguage(value)
          },
          priority: 60
        };
      }
      
      // Priority 40: Long text (>200 chars)
      if (value.length > 200) {
        return {
          component: 'TextArea',
          props: {
            label: this.formatLabel(key),
            text: value
          },
          priority: 40
        };
      }
      
      // Priority 30: Short text
      return {
        component: 'TextField',
        props: {
          label: this.formatLabel(key),
          text: value
        },
        priority: 30
      };
    }
    
    // Boolean
    if (typeof value === 'boolean') {
      return {
        component: 'Checkbox',
        props: {
          label: this.formatLabel(key),
          checked: value,
          disabled: true
        },
        priority: 50
      };
    }
    
      // Fallback
      return {
        component: 'TextField',
        props: {
          label: this.formatLabel(key),
          text: String(value)
        },
        priority: 10
      };
      
    } catch (error) {
      console.error(`Error recognizing primitive pattern for "${key}":`, error);
      return this.errorComponent(key, `Primitive processing error: ${error.message}`);
    }
  }
  
  /**
   * Helper: Format field name to human-readable label
   * @private
   */
  _formatLabel(key) {
    try {
      if (key == null) return 'Unknown';
      if (typeof key !== 'string') key = String(key);
      if (key.length === 0) return 'Empty';
      
      return key
        // Split on underscores, dashes, or camelCase
        .replace(/_/g, ' ')
        .replace(/-/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        // Capitalize first letter of each word
        .split(' ')
        .filter(word => word.length > 0)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
        .trim();
    } catch (error) {
      console.error('Error formatting label:', error);
      return String(key || 'Unknown');
    }
  }
  
  /**
   * Helper: Check if string is ISO timestamp
   * @private
   */
  isTimestamp(value) {
    try {
      if (typeof value !== 'string') return false;
      if (!value || value.length < 19) return false;
      
      // Check format
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return false;
      
      // Validate it's a real date
      const date = new Date(value);
      return !isNaN(date.getTime());
    } catch {
      return false;
    }
  }
  
  /**
   * Helper: Check if string is URL
   * @private
   */
  isUrl(value) {
    if (typeof value !== 'string') return false;
    return /^https?:\/\/.+/.test(value);
  }
  
  /**
   * Helper: Check if string is file path
   * @private
   */
  isFilePath(value) {
    if (typeof value !== 'string') return false;
    // Contains / or \ and has file extension
    return (/\//.test(value) || /\\/.test(value)) && /\.\w+$/.test(value);
  }
  
  /**
   * Helper: Check if string looks like code
   * @private
   */
  looksLikeCode(value) {
    if (typeof value !== 'string') return false;
    // Has newlines AND code markers
    return value.includes('\n') && 
           (value.includes('{') || value.includes('import') || value.includes('function') || 
            value.includes('class') || value.includes('def ') || value.includes('const '));
  }
  
  /**
   * Helper: Check if field name suggests progress
   * @private
   */
  looksLikeProgress(key) {
    const lower = key.toLowerCase();
    return lower.includes('progress') || 
           lower.includes('percent') || 
           lower.includes('completion');
  }
  
  /**
   * Helper: Infer programming language from code
   * @private
   */
  inferLanguage(code) {
    if (code.includes('function') || code.includes('const ') || code.includes('let ')) return 'javascript';
    if (code.includes('def ') || code.includes('import ')) return 'python';
    if (code.includes('public class') || code.includes('private ')) return 'java';
    if (code.includes('interface ') || code.includes(': string')) return 'typescript';
    return 'text';
  }
}



