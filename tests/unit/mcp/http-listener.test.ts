import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { createHttpListener, bindWithPortFallback } from '../../../src/mcp/transports/http-listener.js';
import fetch from 'node-fetch';

/**
 * Find N consecutive free TCP ports starting from a random high port.
 * Avoids hardcoded port numbers that collide on parallel CI runners.
 */
async function findFreePorts(count: number): Promise<number[]> {
  const base = 20000 + Math.floor(Math.random() * 10000);
  const ports: number[] = [];
  for (let p = base; p < base + 200 && ports.length < count; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) ports.push(p);
  }
  if (ports.length < count) throw new Error(`Could not find ${count} free ports`);
  return ports;
}

describe('HttpListener', () => {
  let listeners: ReturnType<typeof createHttpListener>[] = [];

  afterEach(async () => {
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
    const [port] = await findFreePorts(1);
    const listener = createHttpListener(port);
    listeners.push(listener);
    await listener.start();
    expect(listener.getBoundPort()).toBe(port);
    const response = await fetch(`http://localhost:${port}/nonexistent`);
    expect(response.status).toBe(404);
  });

  it('supports ephemeral ports (port=0, OS assigns)', async () => {
    const listener = createHttpListener(0);
    listeners.push(listener);
    expect(listener.requestedPort).toBe(0);
    expect(listener.getBoundPort()).toBeNull();
    await listener.start();
    const boundPort = listener.getBoundPort();
    expect(boundPort).toBeGreaterThan(0);
    const response = await fetch(`http://localhost:${boundPort}/test`);
    expect(response.status).toBe(404);
  });

  it('throws on EADDRINUSE when port is already in use', async () => {
    // Use port 0 for listener1 so OS assigns a guaranteed-free port,
    // then use the bound port for listener2. Avoids race between findFreePorts
    // and listener1.start() where another process could grab the port.
    const listener1 = createHttpListener(0);
    listeners.push(listener1);
    await listener1.start();
    const boundPort = listener1.getBoundPort()!;

    const listener2 = createHttpListener(boundPort);
    listeners.push(listener2);
    await expect(listener2.start()).rejects.toThrow('already in use');
  });

  it('throws when start() is called twice on the same listener', async () => {
    const [port] = await findFreePorts(1);
    const listener = createHttpListener(port);
    listeners.push(listener);
    await listener.start();
    await expect(listener.start()).rejects.toThrow('Already started');
  });

  it('stop() is idempotent (can be called multiple times)', async () => {
    const [port] = await findFreePorts(1);
    const listener = createHttpListener(port);
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
    const [port] = await findFreePorts(1);
    const listener = createHttpListener(port);
    listeners.push(listener);
    listener.app.get('/test', (req, res) => {
      res.json({ message: 'test route' });
    });
    await listener.start();
    const response = await fetch(`http://localhost:${port}/test`);
    const data: any = await response.json();
    expect(data.message).toBe('test route');
  });
});

describe('bindWithPortFallback', () => {
  let boundListeners: ReturnType<typeof createHttpListener>[] = [];

  afterEach(async () => {
    for (const l of boundListeners) {
      await l.stop();
    }
    boundListeners = [];
  });

  it('binds to startPort when it is available', async () => {
    const [port] = await findFreePorts(1);
    const listener = await bindWithPortFallback(port, port + 10);
    boundListeners.push(listener);
    expect(listener.getBoundPort()).toBe(port);
  });

  it('falls back to the next available port when startPort is busy', async () => {
    const [port] = await findFreePorts(2);
    const occupier = createHttpListener(port);
    await occupier.start();
    boundListeners.push(occupier);
    const listener = await bindWithPortFallback(port, port + 10);
    boundListeners.push(listener);
    const boundPort = listener.getBoundPort();
    expect(boundPort).not.toBeNull();
    expect(boundPort!).toBeGreaterThan(port);
    expect(boundPort!).toBeLessThanOrEqual(port + 10);
  });

  it('throws when no port in range is available', async () => {
    const [p1, p2] = await findFreePorts(2);
    const occupiers = [createHttpListener(p1), createHttpListener(p2)];
    for (const occ of occupiers) {
      await occ.start();
      boundListeners.push(occ);
    }
    const range = `${p1}-${p2}`;
    await expect(bindWithPortFallback(p1, p2)).rejects.toThrow(
      `No available port in range ${range}`,
    );
  });
});
