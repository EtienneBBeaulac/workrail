/**
 * Tests for condition formatting functions.
 */

import { describe, it, expect } from 'vitest';
import { 
  buildConditionGuidance, 
  formatDiagnosis, 
  formatBlockedStep 
} from '../../src/utils/condition-analysis/formatting';
import { BlockedStepInfo, ConditionDiagnosis } from '../../src/utils/condition-analysis/types';

describe('buildConditionGuidance', () => {
  it('should return null for empty array', () => {
    const result = buildConditionGuidance([]);
    
    expect(result).toBeNull();
  });
  
  it('should format single blocked step', () => {
    const blocked: BlockedStepInfo[] = [{
      stepId: 'step-1',
      stepTitle: 'My Step',
      condition: { var: 'x', equals: 'y' } as any,
      diagnosis: {
        type: 'missing-variable',
        variable: 'x',
        expectedValues: ['"y"'],
        operator: 'equals'
      },
      relevantContext: {}
    }];
    
    const guidance = buildConditionGuidance(blocked);
    
    expect(guidance).not.toBeNull();
    expect(guidance!.prompt).toContain('1 conditional step is blocked');
    expect(guidance!.prompt).toContain('STEP: step-1');
    expect(guidance!.prompt).toContain('Title: My Step');
    expect(guidance!.prompt).toContain('Missing Required Variable');
  });
  
  it('should format multiple blocked steps', () => {
    const blocked: BlockedStepInfo[] = [
      {
        stepId: 'step-1',
        stepTitle: 'Step 1',
        condition: { var: 'x', equals: 'a' } as any,
        diagnosis: { 
          type: 'missing-variable', 
          variable: 'x', 
          expectedValues: ['"a"'], 
          operator: 'equals' 
        },
        relevantContext: {}
      },
      {
        stepId: 'step-2',
        stepTitle: 'Step 2',
        condition: { var: 'y', equals: 'b' } as any,
        diagnosis: { 
          type: 'wrong-value', 
          variable: 'y', 
          expected: 'b', 
          current: 'c', 
          operator: 'equals' 
        },
        relevantContext: { y: 'c' }
      }
    ];
    
    const guidance = buildConditionGuidance(blocked);
    
    expect(guidance!.prompt).toContain('2 conditional steps are blocked');
    expect(guidance!.prompt).toContain('STEP: step-1');
    expect(guidance!.prompt).toContain('STEP: step-2');
  });
  
  it('should include quick fixes section', () => {
    const blocked: BlockedStepInfo[] = [{
      stepId: 'step-1',
      stepTitle: 'Enable Feature',
      condition: { var: 'enabled', equals: true } as any,
      diagnosis: {
        type: 'missing-variable',
        variable: 'enabled',
        expectedValues: ['true'],
        operator: 'equals'
      },
      relevantContext: {}
    }];
    
    const guidance = buildConditionGuidance(blocked);
    
    expect(guidance!.prompt).toContain('QUICK FIXES');
    expect(guidance!.prompt).toContain('Set enabled = true');
    expect(guidance!.prompt).toContain('Enables "Enable Feature"');
  });
});

describe('formatDiagnosis', () => {
  it('should format missing variable', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'missing-variable',
      variable: 'status',
      expectedValues: ['"ready"', '"active"'],
      operator: 'equals'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('❌ Missing Required Variable');
    expect(formatted).toContain('Variable: status');
    expect(formatted).toContain('Expected: "ready" or "active"');
    expect(formatted).toContain('Current:  undefined');
    expect(formatted).toContain('Fix: Set status = "ready"');
  });
  
  it('should format wrong value with hint', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'wrong-value',
      variable: 'mode',
      expected: 'active',
      current: 'inactive',
      operator: 'equals',
      hint: 'Comparison is case-insensitive'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('❌ Incorrect Value');
    expect(formatted).toContain('Variable: mode');
    expect(formatted).toContain('Expected: "active"');
    expect(formatted).toContain('Current:  "inactive"');
    expect(formatted).toContain('Note: Comparison is case-insensitive');
  });
  
  it('should format wrong type', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'wrong-type',
      variable: 'count',
      expectedType: 'number',
      currentType: 'string',
      operator: 'gt'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('❌ Type Mismatch');
    expect(formatted).toContain('Expected Type: number');
    expect(formatted).toContain('Current Type:  string');
  });
  
  it('should format AND composition', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'and-composition',
      failures: [
        { 
          type: 'missing-variable', 
          variable: 'x', 
          expectedValues: ['"a"'], 
          operator: 'equals' 
        },
        { 
          type: 'wrong-value', 
          variable: 'y', 
          expected: 'b', 
          current: 'c', 
          operator: 'equals' 
        }
      ],
      totalConditions: 2,
      description: 'All 2 conditions must be true, but 2 failed'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('Composite Condition (AND)');
    expect(formatted).toContain('All 2 conditions must pass');
    expect(formatted).toContain('1. ❌ Missing Required Variable');
    expect(formatted).toContain('2. ❌ Incorrect Value');
  });
  
  it('should format OR composition with options', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'or-composition',
      failures: [
        { 
          type: 'wrong-value', 
          variable: 'mode', 
          expected: 'A', 
          current: 'C', 
          operator: 'equals' 
        },
        { 
          type: 'wrong-value', 
          variable: 'mode', 
          expected: 'B', 
          current: 'C', 
          operator: 'equals' 
        }
      ],
      totalOptions: 2,
      description: 'At least one of 2 conditions must be true, but all 2 failed'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('Composite Condition (OR)');
    expect(formatted).toContain('satisfy ANY ONE of these options');
    expect(formatted).toContain('OPTION 1:');
    expect(formatted).toContain('OPTION 2:');
  });
  
  it('should format NOT composition', () => {
    const diagnosis: ConditionDiagnosis = {
      type: 'not-composition',
      negatedDiagnosis: {
        type: 'wrong-value',
        variable: 'disabled',
        expected: true,
        current: true,
        operator: 'equals'
      },
      description: 'Negated condition should be false, but it is true'
    };
    
    const formatted = formatDiagnosis(diagnosis);
    
    expect(formatted).toContain('Negated Condition (NOT)');
    expect(formatted).toContain('should be FALSE but is TRUE');
  });
});

describe('formatBlockedStep', () => {
  it('should format complete blocked step info', () => {
    const step: BlockedStepInfo = {
      stepId: 'phase-analysis',
      stepTitle: 'Deep Analysis Phase',
      condition: { var: 'depth', equals: 'deep' } as any,
      diagnosis: {
        type: 'missing-variable',
        variable: 'depth',
        expectedValues: ['"deep"'],
        operator: 'equals'
      },
      relevantContext: {}
    };
    
    const formatted = formatBlockedStep(step);
    
    expect(formatted).toContain('━━━━━━━━━━━━━━━━');
    expect(formatted).toContain('STEP: phase-analysis');
    expect(formatted).toContain('Title: Deep Analysis Phase');
    expect(formatted).toContain('Missing Required Variable');
    expect(formatted).toContain('Variable: depth');
  });
});
