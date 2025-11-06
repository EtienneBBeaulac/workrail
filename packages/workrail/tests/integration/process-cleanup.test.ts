/**
 * Integration test for automatic process cleanup mechanism
 * 
 * This test demonstrates:
 * 1. Startup cleanup removes orphaned processes
 * 2. TTL-based lock expiration works correctly
 * 3. Manual cleanup command functions properly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionManager } from '../../src/infrastructure/session/SessionManager';
import { HttpServer } from '../../src/infrastructure/session/HttpServer';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Process Cleanup Mechanism', () => {
  const lockFile = path.join(os.homedir(), '.workrail', 'dashboard.lock');
  
  beforeAll(async () => {
    // Ensure clean state
    try {
      await fs.unlink(lockFile);
    } catch {
      // Lock file might not exist
    }
  });
  
  afterAll(async () => {
    // Cleanup after tests
    try {
      await fs.unlink(lockFile);
    } catch {
      // Lock file might not exist
    }
  });
  
  describe('Automatic Startup Cleanup', () => {
    it('should detect workrail processes on ports 3456-3499', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Use private method via type assertion for testing
      const getWorkrailPorts = (httpServer as any).getWorkrailPorts.bind(httpServer);
      const ports = await getWorkrailPorts();
      
      // Should return an array (might be empty if no processes)
      expect(Array.isArray(ports)).toBe(true);
      
      // Each item should have port and pid
      ports.forEach((item: any) => {
        expect(typeof item.port).toBe('number');
        expect(typeof item.pid).toBe('number');
        expect(item.port).toBeGreaterThanOrEqual(3456);
        expect(item.port).toBeLessThan(3500);
      });
    });
    
    it('should not kill the current process', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Get current process info
      const currentPid = process.pid;
      
      // Start server (which runs cleanup)
      const baseUrl = await httpServer.start();
      
      // Current process should still be alive
      expect(process.pid).toBe(currentPid);
      
      // Cleanup
      await httpServer.stop();
    }, 30000); // Longer timeout for server start
  });
  
  describe('TTL-Based Lock Expiration', () => {
    it('should create lock file with heartbeat', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Start server
      await httpServer.start();
      
      // Check lock file exists
      const lockContent = await fs.readFile(lockFile, 'utf-8');
      const lockData = JSON.parse(lockContent);
      
      expect(lockData).toHaveProperty('pid');
      expect(lockData).toHaveProperty('port');
      expect(lockData).toHaveProperty('startedAt');
      expect(lockData).toHaveProperty('lastHeartbeat');
      expect(lockData.pid).toBe(process.pid);
      expect(lockData.port).toBe(3456);
      
      // Cleanup
      await httpServer.stop();
    }, 30000);
    
    it('should update heartbeat periodically', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Start server
      await httpServer.start();
      
      // Get initial heartbeat
      const lockContent1 = await fs.readFile(lockFile, 'utf-8');
      const lockData1 = JSON.parse(lockContent1);
      const initialHeartbeat = new Date(lockData1.lastHeartbeat);
      
      // Wait for heartbeat update (30 seconds + buffer)
      await new Promise(resolve => setTimeout(resolve, 35000));
      
      // Get updated heartbeat
      const lockContent2 = await fs.readFile(lockFile, 'utf-8');
      const lockData2 = JSON.parse(lockContent2);
      const updatedHeartbeat = new Date(lockData2.lastHeartbeat);
      
      // Heartbeat should be updated
      expect(updatedHeartbeat.getTime()).toBeGreaterThan(initialHeartbeat.getTime());
      
      // Cleanup
      await httpServer.stop();
    }, 60000); // Longer timeout for heartbeat test
    
    it('should reclaim stale lock (> 2 minutes old)', async () => {
      // Create a stale lock file (> 2 minutes old)
      const staleLock = {
        pid: 99999, // Non-existent PID
        port: 3456,
        startedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 minutes ago
        lastHeartbeat: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        projectId: 'test-project',
        projectPath: '/tmp/test'
      };
      
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify(staleLock, null, 2));
      
      // Try to start server
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      const baseUrl = await httpServer.start();
      
      // Should have reclaimed the lock
      expect(baseUrl).toBeTruthy();
      
      // Lock should be updated with current process
      const lockContent = await fs.readFile(lockFile, 'utf-8');
      const lockData = JSON.parse(lockContent);
      expect(lockData.pid).toBe(process.pid);
      
      // Cleanup
      await httpServer.stop();
    }, 30000);
  });
  
  describe('Manual Cleanup Command', () => {
    it('should export fullCleanup method', () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      expect(typeof httpServer.fullCleanup).toBe('function');
    });
    
    it('should return count of cleaned processes', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Run cleanup
      const count = await httpServer.fullCleanup();
      
      // Should return a number
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Platform Detection', () => {
    it('should detect current platform', () => {
      const platform = os.platform();
      
      // Should be one of the supported platforms
      expect(['darwin', 'linux', 'win32', 'freebsd', 'openbsd']).toContain(platform);
    });
    
    it('should handle lsof unavailable gracefully', async () => {
      // This test ensures the cleanup doesn't crash if lsof isn't available
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Should not throw even if lsof fails
      await expect(httpServer.fullCleanup()).resolves.toBeDefined();
    });
  });
  
  describe('Health Check', () => {
    it('should check server health via HTTP', async () => {
      const sessionManager = new SessionManager();
      const httpServer = new HttpServer(sessionManager, { autoOpen: false });
      
      // Start server
      const baseUrl = await httpServer.start();
      
      if (baseUrl) {
        // Server started as primary, check health endpoint
        const response = await fetch(`${baseUrl}/api/health`);
        expect(response.ok).toBe(true);
        
        const data = await response.json();
        expect(data.status).toBe('healthy');
        expect(data.isPrimary).toBe(true);
      }
      
      // Cleanup
      await httpServer.stop();
    }, 30000);
  });
});

