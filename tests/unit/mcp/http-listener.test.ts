import { describe, it, expect, afterEach } from 'vitest';
import { createHttpListener } from '../../../src/mcp/transports/http-listener.js';
import fetch from 'node-fetch';

describe('HttpListener', () => {
  let listeners: ReturnType<typeof createHttpListener>[] = [];

  afterEach(async () => {
    // Clean up all listeners
    for (const listener of listeners) {
      await listener.stop();
    }
    listeners = [];
  });

  it('creates a listener with the specified port', () => {
    const listener = createHttpListener(3200);
    listeners.push(listener);
    
    expect(listener.requestedPort).toBe(3200);
    expect(listener.getBoundPort()).toBeNull(); // Not started yet
    expect(listener.app).toBeDefined();
  });

  it('starts successfully and binds to the requested port', async () => {
    const listener = createHttpListener(13300);
    listeners.push(listener);
    
    await listener.start();
    
    expect(listener.getBoundPort()).toBe(13300);
    
    // Verify it's listening by making a request
    const response = await fetch(`http://localhost:13300/nonexistent`);
    expect(response.status).toBe(404); // Express default 404
  });

  it('supports ephemeral ports (port=0, OS assigns)', async () => {
    const listener = createHttpListener(0);
    listeners.push(listener);
    
    expect(listener.requestedPort).toBe(0);
    expect(listener.getBoundPort()).toBeNull(); // Not started yet
    
    await listener.start();
    
    const boundPort = listener.getBoundPort();
    expect(boundPort).toBeGreaterThan(0); // OS assigned a real port
    
    // Verify it's actually listening on that port
    const response = await fetch(`http://localhost:${boundPort}/test`);
    expect(response.status).toBe(404);
  });

  it('throws on EADDRINUSE when port is already in use', async () => {
    const listener1 = createHttpListener(13200);
    const listener2 = createHttpListener(13200);
    listeners.push(listener1, listener2);
    
    await listener1.start();
    
    await expect(listener2.start()).rejects.toThrow(
      'Port 13200 is already in use'
    );
  });

  it('throws when start() is called twice on the same listener', async () => {
    const listener = createHttpListener(13301);
    listeners.push(listener);
    
    await listener.start();
    
    await expect(listener.start()).rejects.toThrow('Already started');
  });

  it('stop() is idempotent (can be called multiple times)', async () => {
    const listener = createHttpListener(13302);
    listeners.push(listener);
    
    await listener.start();
    await listener.stop();
    await listener.stop(); // Should not throw
  });

  it('stop() on non-started listener is a no-op', async () => {
    const listener = createHttpListener(3201);
    listeners.push(listener);
    
    await listener.stop(); // Should not throw
  });

  it('allows mounting routes on the Express app before starting', async () => {
    const listener = createHttpListener(13303);
    listeners.push(listener);
    
    listener.app.get('/test', (req, res) => {
      res.json({ message: 'test route' });
    });
    
    await listener.start();
    
    const response = await fetch(`http://localhost:13303/test`);
    const data: any = await response.json();
    
    expect(data.message).toBe('test route');
  });
});
