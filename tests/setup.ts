// Jest setup file
import 'reflect-metadata';
import { config } from 'dotenv';
import { beforeAll, afterAll } from '@jest/globals';
import { teardownTest } from './di/test-container.js';

// Load environment variables from .env file - suppress console output
config({ quiet: true });

// Global test resource tracking
const globalResources = new Set<() => Promise<void>>();

// Global test setup
beforeAll(() => {
  // Setup any global test configuration
  console.log('🧪 Jest environment initialized');
});

afterAll(async () => {
  // Cleanup DI container
  teardownTest();
  
  // Cleanup any global test resources
  console.log('🧹 Cleaning up global test resources...');
  
  // Clean up all tracked resources
  for (const cleanup of globalResources) {
    try {
      await cleanup();
    } catch (error) {
      console.error('Error during resource cleanup:', error);
    }
  }
  
  globalResources.clear();
  console.log('✅ Global test cleanup completed');
});

// Helper to track resources for cleanup
export function trackResource(cleanupFn: () => Promise<void>): void {
  globalResources.add(cleanupFn);
}

// Helper to remove tracked resource
export function untrackResource(cleanupFn: () => Promise<void>): void {
  globalResources.delete(cleanupFn);
}

// Add process cleanup handlers
process.on('exit', () => {
  console.log('📋 Process exiting, final cleanup...');
});

process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, cleaning up...');
  for (const cleanup of globalResources) {
    try {
      await cleanup();
    } catch (error) {
      console.error('Error during SIGINT cleanup:', error);
    }
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, cleaning up...');
  for (const cleanup of globalResources) {
    try {
      await cleanup();
    } catch (error) {
      console.error('Error during SIGTERM cleanup:', error);
    }
  }
  process.exit(0);
}); 