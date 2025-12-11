/**
 * Workflow Initialization Utilities
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Initialize user workflow directory if it doesn't exist.
 * Creates ~/.workrail/workflows with a sample workflow.
 */
export async function initializeUserWorkflowDirectory(): Promise<string> {
  const userDir = path.join(os.homedir(), '.workrail', 'workflows');
  
  try {
    await fs.mkdir(userDir, { recursive: true });
    
    const entries = await fs.readdir(userDir);
    if (entries.length === 0) {
      const sampleWorkflow = {
        id: 'my-custom-workflow',
        name: 'My Custom Workflow',
        description: 'A template for creating custom workflows',
        version: '1.0.0',
        steps: [
          {
            id: 'step-1',
            title: 'First Step',
            prompt: 'Replace this with your custom step',
            agentRole: 'You are helping the user with their custom workflow'
          }
        ]
      };
      
      await fs.writeFile(
        path.join(userDir, 'my-custom-workflow.json'),
        JSON.stringify(sampleWorkflow, null, 2)
      );
    }
    
    return userDir;
  } catch (error) {
    console.warn('Failed to initialize user workflow directory:', error);
    throw error;
  }
}
