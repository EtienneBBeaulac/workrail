import { IApplicationMediator } from '../app';

// Context optimization instructions to inject
const CONTEXT_OPTIMIZATION_TEXT = `

**CONTEXT OPTIMIZATION REQUIREMENTS**:

The MCP server is STATELESS. You MUST send required data with each request:

**ALWAYS INCLUDE:**
1. \`workflowId\` - Required for all calls
2. \`completedSteps\` - Full array of completed step IDs
3. **Condition Variables** - ANY variable used in step \`runCondition\` fields
4. **Template Variables** - ANY variable referenced in {{templates}} in prompts/titles
5. **Your New/Modified Variables** - Variables you created or changed in this step

**CONDITIONALLY INCLUDE:**
- **Loop Variables** (when in a loop): \`currentIteration\`, \`currentItem\`, \`currentIndex\`
- **Active Loop State**: Only \`_loopState[currentLoopId]\` if currently in a loop
- **Referenced Variables**: Any variable that future steps might need

**NEVER INCLUDE:**
- Large arrays that aren't being actively iterated (e.g., \`implementationSteps\` array)
- Stale loop states from completed loops
- Unreferenced historical data
- Variables only used in completed steps

**SIZE TARGETS:**
- Normal steps: < 2KB
- Loop iterations: < 5KB
- Complex state: < 10KB

**EXAMPLE - Loop Context:**
\`\`\`json
{
  "workflowId": "coding-task-workflow-with-loops",
  "completedSteps": ["phase-1", "phase-2", "loop-step-1"],
  "context": {
    // Required: condition/template variables
    "taskComplexity": "Medium",
    "totalImplementationSteps": 8,
    "currentStepNumber": 3,
    
    // Required: your changes
    "stepCompleted": true,
    "testResults": "passed",
    
    // Required: active loop state only
    "_loopState": {
      "phase-6-loop": { "iteration": 3 }
    },
    
    // DON'T include:
    // - implementationSteps: [...] // Large array
    // - analysisResults: {...} // From phase 1
    // - _loopState.oldLoop: {...} // Completed loop
  }
}
\`\`\`

**VALIDATION CHECK**: Before sending, verify you have ALL variables referenced in:
- The next step's \`runCondition\`
- Any {{variable}} in the next step's prompts
- Variables needed for loop control`;

/**
 * Decorator that adds context optimization instructions to workflow_next responses.
 * This helps agents understand they should send minimal context back to reduce token usage.
 * 
 * Follows the decorator pattern established by CachingWorkflowStorage.
 * User Rules Applied:
 * - Uses dependency injection pattern
 * - Maintains immutability (doesn't modify original response)
 * - Follows Clean Architecture (single responsibility)
 * - Stateless implementation
 */
export class SimpleOutputDecorator implements IApplicationMediator {
  constructor(private readonly wrapped: IApplicationMediator) {}

  /**
   * Intercepts execute calls and adds optimization text to workflow_next responses
   */
  async execute(method: string, params: any): Promise<any> {
    // Get the original response
    const result = await this.wrapped.execute(method, params);
    
    // Only modify workflow_next responses that have guidance
    if (method === 'workflow_next' && result?.guidance?.prompt) {
      // Create a new response object to maintain immutability
      return {
        ...result,
        guidance: {
          ...result.guidance,
          prompt: result.guidance.prompt + CONTEXT_OPTIMIZATION_TEXT
        }
      };
    }
    
    // Pass through all other responses unchanged
    return result;
  }

  /**
   * Delegate all other methods to the wrapped mediator
   */
  register(method: string, handler: any): void {
    this.wrapped.register(method, handler);
  }

  setResponseValidator(fn: (method: string, result: any) => void): void {
    this.wrapped.setResponseValidator(fn);
  }
}