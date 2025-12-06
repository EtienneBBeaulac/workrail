/**
 * Tests for LoopStackFrame immutability.
 * 
 * Verifies:
 * - Smart constructors create frozen frames
 * - Frame operations return new frames
 * - Original frames unchanged
 * - Stack replacement works correctly
 */

import { describe, it, expect } from 'vitest';
import { 
  createLoopStackFrame,
  advanceBodyIndex,
  resetBodyIndex,
  setBodyIndex,
  replaceTopFrame,
  LoopStackFrame
} from '../../src/types/workflow-types';

describe('LoopStackFrame Immutability', () => {
  // Helper to create mock loopContext with working incrementIteration
  function createMockLoopContext() {
    let iteration = 0;
    return {
      getCurrentState: () => ({ iteration, items: [], index: 0, started: Date.now() }),
      shouldContinue: () => true,
      incrementIteration: () => { iteration++; },
      isFirstIteration: () => iteration === 0,
      injectVariables: (ctx: any) => ctx
    };
  }
  
  const mockLoopStep = {
    id: 'test-loop',
    type: 'loop',
    title: 'Test Loop',
    prompt: 'Test',
    loop: { type: 'for', count: 3, maxIterations: 10 }
  } as any;
  
  const mockBodySteps = [
    { id: 'step-1', title: 'Step 1', prompt: 'Step 1' },
    { id: 'step-2', title: 'Step 2', prompt: 'Step 2' },
    { id: 'step-3', title: 'Step 3', prompt: 'Step 3' }
  ];

  describe('createLoopStackFrame', () => {
    it('should create frozen frame', () => {
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame.bodySteps)).toBe(true);
    });
    
    it('should initialize with default index of 0', () => {
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps
      );
      
      expect(frame.currentBodyIndex).toBe(0);
    });
    
    it('should accept custom starting index', () => {
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        5
      );
      
      expect(frame.currentBodyIndex).toBe(5);
    });

    it('should freeze bodySteps array if not already frozen', () => {
      const mutableArray = [...mockBodySteps];
      expect(Object.isFrozen(mutableArray)).toBe(false);
      
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mutableArray,
        0
      );
      
      expect(Object.isFrozen(frame.bodySteps)).toBe(true);
    });
  });

  describe('advanceBodyIndex', () => {
    it('should return new frame with incremented index', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      const frame2 = advanceBodyIndex(frame1);
      
      expect(frame1.currentBodyIndex).toBe(0);  // Original unchanged
      expect(frame2.currentBodyIndex).toBe(1);  // New frame incremented
      expect(frame1).not.toBe(frame2);          // Different objects
      expect(Object.isFrozen(frame2)).toBe(true);
    });
    
    it('should preserve all other fields', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        2
      );
      
      const frame2 = advanceBodyIndex(frame1);
      
      expect(frame2.loopId).toBe(frame1.loopId);
      expect(frame2.loopStep).toBe(frame1.loopStep);
      expect(frame2.loopContext).toBe(frame1.loopContext);  // Same reference
      expect(frame2.bodySteps).toBe(frame1.bodySteps);      // Same frozen array
    });
    
    it('should handle multiple consecutive advances', () => {
      let frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      frame = advanceBodyIndex(frame);
      expect(frame.currentBodyIndex).toBe(1);
      
      frame = advanceBodyIndex(frame);
      expect(frame.currentBodyIndex).toBe(2);
      
      frame = advanceBodyIndex(frame);
      expect(frame.currentBodyIndex).toBe(3);
    });
  });

  describe('resetBodyIndex', () => {
    it('should return new frame with index reset to 0', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        5
      );
      
      const frame2 = resetBodyIndex(frame1);
      
      expect(frame1.currentBodyIndex).toBe(5);  // Original unchanged
      expect(frame2.currentBodyIndex).toBe(0);  // New frame reset
      expect(frame1).not.toBe(frame2);          // Different objects
      expect(Object.isFrozen(frame2)).toBe(true);
    });

    it('should preserve all other fields', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        7
      );
      
      const frame2 = resetBodyIndex(frame1);
      
      expect(frame2.loopId).toBe(frame1.loopId);
      expect(frame2.loopStep).toBe(frame1.loopStep);
      expect(frame2.loopContext).toBe(frame1.loopContext);
      expect(frame2.bodySteps).toBe(frame1.bodySteps);
    });
  });

  describe('setBodyIndex', () => {
    it('should return new frame with specific index', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      const frame2 = setBodyIndex(frame1, 7);
      
      expect(frame1.currentBodyIndex).toBe(0);  // Original unchanged
      expect(frame2.currentBodyIndex).toBe(7);  // New frame set
      expect(frame1).not.toBe(frame2);
      expect(Object.isFrozen(frame2)).toBe(true);
    });

    it('should work with any valid index', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      expect(setBodyIndex(frame1, 0).currentBodyIndex).toBe(0);
      expect(setBodyIndex(frame1, 1).currentBodyIndex).toBe(1);
      expect(setBodyIndex(frame1, 99).currentBodyIndex).toBe(99);
    });
  });

  describe('replaceTopFrame', () => {
    it('should replace top frame in stack', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      const stack = [frame1];
      const frame2 = advanceBodyIndex(frame1);
      
      const returned = replaceTopFrame(stack, frame2);
      
      expect(returned).toBe(frame2);           // Returns new frame
      expect(stack[0]).toBe(frame2);           // Stack updated
      expect(stack.length).toBe(1);            // Stack size unchanged
    });
    
    it('should throw if stack is empty', () => {
      const stack: LoopStackFrame[] = [];
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps
      );
      
      expect(() => replaceTopFrame(stack, frame)).toThrow(/empty stack/);
    });
    
    it('should enable chaining pattern', () => {
      const stack = [createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      )];
      
      // Pattern: frame = replaceTopFrame(stack, operation(frame))
      let frame = stack[0];
      
      frame = replaceTopFrame(stack, advanceBodyIndex(frame));
      expect(frame.currentBodyIndex).toBe(1);
      expect(stack[0].currentBodyIndex).toBe(1);
      
      frame = replaceTopFrame(stack, advanceBodyIndex(frame));
      expect(frame.currentBodyIndex).toBe(2);
      expect(stack[0].currentBodyIndex).toBe(2);
      
      frame = replaceTopFrame(stack, resetBodyIndex(frame));
      expect(frame.currentBodyIndex).toBe(0);
      expect(stack[0].currentBodyIndex).toBe(0);
    });

    it('should work with multiple frames in stack', () => {
      const frame1 = createLoopStackFrame('loop-1', mockLoopStep, createMockLoopContext(), mockBodySteps, 0);
      const frame2 = createLoopStackFrame('loop-2', mockLoopStep, createMockLoopContext(), mockBodySteps, 0);
      
      const stack = [frame1, frame2];
      const frame3 = advanceBodyIndex(frame2);
      
      replaceTopFrame(stack, frame3);
      
      expect(stack[0]).toBe(frame1);  // Bottom unchanged
      expect(stack[1]).toBe(frame3);  // Top replaced
    });
  });

  describe('Immutability guarantees', () => {
    it('should prevent direct mutation via runtime freeze', () => {
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      // TypeScript prevents: frame.currentBodyIndex = 5
      // But verify runtime freeze prevents it too
      expect(() => {
        (frame as any).currentBodyIndex = 5;
      }).toThrow(TypeError);  // Frozen object throws in strict mode
    });
    
    it('should allow loopContext mutations (shallow immutability)', () => {
      const mockContext = createMockLoopContext();
      const frame = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        mockContext,
        mockBodySteps
      );
      
      // loopContext is intentionally mutable
      const beforeIteration = frame.loopContext.getCurrentState().iteration;
      expect(beforeIteration).toBe(0);
      
      frame.loopContext.incrementIteration();
      
      const afterIteration = frame.loopContext.getCurrentState().iteration;
      expect(afterIteration).toBe(1);
      
      // This is expected - loopContext manages its own state
    });

    it('should share bodySteps array across frame operations (memory efficiency)', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      const frame2 = advanceBodyIndex(frame1);
      const frame3 = resetBodyIndex(frame2);
      
      // All frames should share the same frozen bodySteps array
      expect(frame1.bodySteps).toBe(frame2.bodySteps);
      expect(frame2.bodySteps).toBe(frame3.bodySteps);
    });

    it('should share loopContext across frame operations (mutable state)', () => {
      const mockContext = createMockLoopContext();
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        mockContext,
        mockBodySteps,
        0
      );
      
      const frame2 = advanceBodyIndex(frame1);
      
      // loopContext is shared (same reference)
      expect(frame1.loopContext).toBe(frame2.loopContext);
      expect(frame1.loopContext).toBe(mockContext);
      expect(frame2.loopContext).toBe(mockContext);
      
      // Mutations to loopContext affect both frames (shared state)
      const before = mockContext.getCurrentState().iteration;
      mockContext.incrementIteration();
      const after = mockContext.getCurrentState().iteration;
      
      expect(after).toBe(before + 1);
      expect(frame1.loopContext.getCurrentState().iteration).toBe(after);
      expect(frame2.loopContext.getCurrentState().iteration).toBe(after);
    });
  });

  describe('Integration: Multi-step scanning pattern', () => {
    it('should support typical scanning workflow', () => {
      const stack = [createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      )];
      
      let frame = stack[0];
      
      // Simulate scanning with skips
      frame = replaceTopFrame(stack, advanceBodyIndex(frame));  // Skip step 0
      expect(frame.currentBodyIndex).toBe(1);
      
      frame = replaceTopFrame(stack, advanceBodyIndex(frame));  // Skip step 1
      expect(frame.currentBodyIndex).toBe(2);
      
      // Found eligible step at index 2 (don't advance)
      // Return step...
      
      // Later: Step completed, advance
      frame = replaceTopFrame(stack, advanceBodyIndex(frame));
      expect(frame.currentBodyIndex).toBe(3);
      
      // Body complete, reset for next iteration
      frame = replaceTopFrame(stack, resetBodyIndex(frame));
      expect(frame.currentBodyIndex).toBe(0);
      
      // All frames in this sequence were immutable
    });
  });

  describe('Recovery pattern', () => {
    it('should support setting arbitrary index for recovery', () => {
      const frame1 = createLoopStackFrame(
        'loop-1',
        mockLoopStep,
        createMockLoopContext(),
        mockBodySteps,
        0
      );
      
      // Simulate recovery: resume from middle of body
      const recoveredFrame = setBodyIndex(frame1, 2);
      
      expect(recoveredFrame.currentBodyIndex).toBe(2);
      expect(frame1.currentBodyIndex).toBe(0);  // Original unchanged
    });
  });
});
