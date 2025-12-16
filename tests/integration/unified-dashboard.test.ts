/**
 * Integration Tests: Unified Dashboard
 * 
 * Tests the primary/secondary pattern, lock file management,
 * and multi-instance scenarios.
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { initializeContainer, resetContainer, container } from '../../src/di/container';
import { DI } from '../../src/di/tokens';
import { HttpServer } from '../../src/infrastructure/session/HttpServer';
import { SessionManager } from '../../src/infrastructure/session/SessionManager';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Unified Dashboard - Primary/Secondary Pattern', () => {
  const lockFile = path.join(os.homedir(), '.workrail', 'dashboard.lock');
  let httpServer: HttpServer;
  
  beforeAll(async () => {
    await initializeContainer();
  });
  
  beforeEach(async () => {
    // Clean up any existing lock file
    await fs.unlink(lockFile).catch(() => {});
    
    // Get fresh instance from DI
    httpServer = container.resolve<HttpServer>(DI.Infra.HttpServer);
    httpServer.setConfig({ browserBehavior: { kind: 'manual' } });
  });
  
  afterEach(async () => {
    // Stop server
    try {
      await httpServer.stop();
    } catch {}
    
    // Clean up lock file
    await fs.unlink(lockFile).catch(() => {});
  });
  
  afterAll(() => {
    resetContainer();
  });
  
  it('should elect first instance as primary', async () => {
    const url = await httpServer.start();
    
    expect(url).toBe('http://localhost:3456');
    expect(httpServer.getPort()).toBe(3456);
    
    // Check lock file was created
    const lockExists = await fs.access(lockFile).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);
    
    // Check lock file content
    const lockData = JSON.parse(await fs.readFile(lockFile, 'utf-8'));
    expect(lockData.port).toBe(3456);
    expect(lockData.pid).toBe(process.pid);
  });
  
  it('should reclaim stale lock from dead process', async () => {
    // Create a stale lock file with a non-existent PID
    const staleLock = {
      pid: 999999, // Invalid PID
      port: 3456,
      startedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 minutes ago
      lastHeartbeat: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      projectId: 'test',
      projectPath: '/tmp/test'
    };
    
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify(staleLock));
    
    const url = await httpServer.start();
    
    // Should reclaim the lock and become primary
    expect(url).toBe('http://localhost:3456');
    
    // Check lock was updated
    const lockData = JSON.parse(await fs.readFile(lockFile, 'utf-8'));
    expect(lockData.pid).toBe(process.pid);
  });
  
  it('should fall back to legacy mode when unified dashboard disabled', async () => {
    // Force legacy mode
    httpServer.setConfig({
      dashboardMode: { kind: 'legacy' },
      browserBehavior: { kind: 'manual' }
    });
    
    const url = await httpServer.start();
    
    // Should fall back to port 3457
    expect(url).toBe('http://localhost:3457');
    expect(httpServer.getPort()).toBe(3457);
  });
});

describe('Unified Dashboard - API Endpoints', () => {
  const lockFile = path.join(os.homedir(), '.workrail', 'dashboard.lock');
  let httpServer: HttpServer;
  
  beforeAll(async () => {
    await initializeContainer();
  });
  
  beforeEach(async () => {
    // Clean up any existing lock file
    await fs.unlink(lockFile).catch(() => {});
    
    httpServer = container.resolve<HttpServer>(DI.Infra.HttpServer);
    httpServer.setConfig({ browserBehavior: { kind: 'manual' } });
    await httpServer.start();
  });
  
  afterEach(async () => {
    try {
      await httpServer.stop();
    } catch {}
    await fs.unlink(lockFile).catch(() => {});
  });
  
  afterAll(() => {
    resetContainer();
  });
  
  it('should return unified flag in sessions API when primary', async () => {
    const response = await fetch('http://localhost:3456/api/sessions');
    const data = await response.json();
    
    expect(data.success).toBe(true);
    expect(data.unified).toBe(true); // Primary serves unified view
    expect(Array.isArray(data.sessions)).toBe(true);
  });
  
  it('should return isPrimary flag in health check', async () => {
    const response = await fetch('http://localhost:3456/api/health');
    const data = await response.json();
    
    expect(data.status).toBe('healthy');
    expect(data.isPrimary).toBe(true);
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(3456);
  });
});
