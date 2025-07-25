import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { RpcClient } from '../../helpers/rpc-client';
import { PerformanceBenchmark } from '../utils/benchmark';
import { generatePerformanceReport } from '../utils/statistics';
import { Workflow } from '../../../src/types/mcp-types';
import { LoopStep } from '../../../src/types/workflow-types';

describe('Loop Workflow Performance Tests', () => {
  const SERVER_PATH = path.resolve(__dirname, '../../../src/index.ts');
  const LOOP_PERFORMANCE_TARGETS = {
    p50: 10,     // Target: <10ms overhead per loop iteration
    p95: 25,     // Allow some variance
    p99: 50      // Maximum acceptable overhead
  };

  let client: RpcClient;
  let benchmark: PerformanceBenchmark;

  beforeAll(async () => {
    client = new RpcClient(SERVER_PATH, { disableGlobalTracking: true });
    benchmark = new PerformanceBenchmark();
    console.log('🚀 Starting loop performance tests');
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    console.log('🏁 Completed loop performance tests');
  });

  describe('Single loop iteration overhead', () => {
    it('should have <10ms overhead for while loop iteration', async () => {
      // First measure baseline (no loop)
      const baselineResult = await benchmark.measureEndpoint(
        client,
        'workflow_next',
        { 
          workflowId: 'coding-task-workflow',
          completedSteps: []
        },
        {
          warmupIterations: 5,
          measurementIterations: 50,
          timeoutMs: 5000
        }
      );

      // Now measure with a simple while loop
      const loopResult = await benchmark.measureEndpoint(
        client,
        'workflow_next',
        { 
          workflowId: 'simple-while-loop',
          completedSteps: [],
          context: { counter: 0, limit: 10 }
        },
        {
          warmupIterations: 5,
          measurementIterations: 50,
          timeoutMs: 5000
        }
      );

      // Calculate overhead
      const overhead = loopResult.p50 - baselineResult.p50;
      
      console.log(`Loop overhead: ${overhead.toFixed(2)}ms (baseline: ${baselineResult.p50.toFixed(2)}ms, with loop: ${loopResult.p50.toFixed(2)}ms)`);
      
      expect(overhead).toBeLessThan(LOOP_PERFORMANCE_TARGETS.p50);
    });

    it('should handle forEach loops efficiently with large arrays', async () => {
      // Test with different array sizes
      const arraySizes = [10, 50, 100, 500];
      const results: { size: number; avgTime: number; perItemTime: number }[] = [];

      for (const size of arraySizes) {
        const items = Array.from({ length: size }, (_, i) => `item-${i}`);
        
        const result = await benchmark.measureEndpoint(
          client,
          'workflow_next',
          { 
            workflowId: 'foreach-performance-test',
            completedSteps: [],
            context: { items }
          },
          {
            warmupIterations: 3,
            measurementIterations: 20,
            timeoutMs: 10000
          }
        );

        const perItemTime = result.p50 / size;
        results.push({ size, avgTime: result.p50, perItemTime });
        
        console.log(`Array size ${size}: ${result.p50.toFixed(2)}ms total, ${perItemTime.toFixed(3)}ms per item`);
      }

      // Verify performance doesn't degrade significantly with larger arrays
      const smallArrayPerItem = results[0].perItemTime;
      const largeArrayPerItem = results[results.length - 1].perItemTime;
      const degradation = ((largeArrayPerItem - smallArrayPerItem) / smallArrayPerItem) * 100;
      
      console.log(`Performance degradation: ${degradation.toFixed(1)}%`);
      expect(degradation).toBeLessThan(50); // Allow up to 50% degradation
    });

    it('should handle nested multi-step loop bodies efficiently', async () => {
      const result = await benchmark.measureEndpoint(
        client,
        'workflow_next',
        { 
          workflowId: 'multi-step-loop-workflow',
          completedSteps: [],
          context: { iterations: 5 }
        },
        {
          warmupIterations: 5,
          measurementIterations: 50,
          timeoutMs: 10000
        }
      );

      const report = generatePerformanceReport('multi-step-loop', result, LOOP_PERFORMANCE_TARGETS);
      console.log(report);

      expect(result.p95).toBeLessThan(LOOP_PERFORMANCE_TARGETS.p95);
    });
  });

  describe('Context size impact on loop performance', () => {
    it('should maintain performance with growing context', async () => {
      const contextSizes = [1, 10, 50, 100]; // KB
      const results: { sizeKB: number; avgTime: number }[] = [];

      for (const sizeKB of contextSizes) {
        // Create context of specified size
        const dataSize = sizeKB * 1024;
        const context = {
          counter: 0,
          data: 'x'.repeat(dataSize)
        };

        const result = await benchmark.measureEndpoint(
          client,
          'workflow_next',
          { 
            workflowId: 'context-test-loop',
            completedSteps: [],
            context
          },
          {
            warmupIterations: 3,
            measurementIterations: 30,
            timeoutMs: 10000
          }
        );

        results.push({ sizeKB, avgTime: result.p50 });
        console.log(`Context size ${sizeKB}KB: ${result.p50.toFixed(2)}ms`);
      }

      // Check that performance degradation is linear or better
      const smallContext = results[0].avgTime;
      const largeContext = results[results.length - 1].avgTime;
      const timeIncrease = largeContext - smallContext;
      const sizeIncrease = results[results.length - 1].sizeKB - results[0].sizeKB;
      const msPerKB = timeIncrease / sizeIncrease;

      console.log(`Performance impact: ${msPerKB.toFixed(3)}ms per KB of context`);
      expect(msPerKB).toBeLessThan(0.5); // Should add less than 0.5ms per KB
    });
  });

  describe('Loop state management efficiency', () => {
    it('should efficiently manage loop state updates', async () => {
      // Test state update performance across iterations
      const iterationCounts = [1, 5, 10, 20];
      const results: { iterations: number; avgTime: number; perIterationTime: number }[] = [];

      for (const iterations of iterationCounts) {
        const result = await benchmark.measureEndpoint(
          client,
          'workflow_next',
          { 
            workflowId: 'state-update-loop',
            completedSteps: [],
            context: { maxIterations: iterations }
          },
          {
            warmupIterations: 3,
            measurementIterations: 30,
            timeoutMs: 10000
          }
        );

        const perIterationTime = result.p50 / iterations;
        results.push({ iterations, avgTime: result.p50, perIterationTime });
        
        console.log(`${iterations} iterations: ${result.p50.toFixed(2)}ms total, ${perIterationTime.toFixed(3)}ms per iteration`);
      }

      // Verify consistent per-iteration performance
      const times = results.map(r => r.perIterationTime);
      const avgPerIteration = times.reduce((a, b) => a + b) / times.length;
      const maxDeviation = Math.max(...times.map(t => Math.abs(t - avgPerIteration)));
      const deviationPercent = (maxDeviation / avgPerIteration) * 100;

      console.log(`Per-iteration time deviation: ${deviationPercent.toFixed(1)}%`);
      expect(deviationPercent).toBeLessThan(25); // Should be consistent within 25%
    });
  });
}); 