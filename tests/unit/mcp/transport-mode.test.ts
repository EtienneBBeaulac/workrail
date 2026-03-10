import { describe, it, expect } from 'vitest';
import { resolveTransportMode } from '../../../src/mcp/transports/transport-mode.js';

describe('TransportMode resolution', () => {
  it('defaults to stdio when WORKRAIL_TRANSPORT is unset', () => {
    const mode = resolveTransportMode({});
    expect(mode).toEqual({ kind: 'stdio' });
  });

  it('returns stdio when WORKRAIL_TRANSPORT=stdio', () => {
    const mode = resolveTransportMode({ WORKRAIL_TRANSPORT: 'stdio' });
    expect(mode).toEqual({ kind: 'stdio' });
  });

  it('returns http mode with default port 3100 when WORKRAIL_TRANSPORT=http', () => {
    const mode = resolveTransportMode({ WORKRAIL_TRANSPORT: 'http' });
    expect(mode).toEqual({ kind: 'http', port: 3100 });
  });

  it('returns http mode with custom port when WORKRAIL_HTTP_PORT is set', () => {
    const mode = resolveTransportMode({
      WORKRAIL_TRANSPORT: 'http',
      WORKRAIL_HTTP_PORT: '8080',
    });
    expect(mode).toEqual({ kind: 'http', port: 8080 });
  });

  it('throws on invalid transport value', () => {
    expect(() => resolveTransportMode({ WORKRAIL_TRANSPORT: 'websocket' })).toThrow(
      'Invalid WORKRAIL_TRANSPORT: "websocket"'
    );
  });

  it('throws on invalid port (not a number)', () => {
    expect(() =>
      resolveTransportMode({ WORKRAIL_TRANSPORT: 'http', WORKRAIL_HTTP_PORT: 'abc' })
    ).toThrow('Invalid WORKRAIL_HTTP_PORT: "abc"');
  });

  it('throws on invalid port (negative)', () => {
    expect(() =>
      resolveTransportMode({ WORKRAIL_TRANSPORT: 'http', WORKRAIL_HTTP_PORT: '-1' })
    ).toThrow('Invalid WORKRAIL_HTTP_PORT: "-1"');
  });

  it('throws on invalid port (out of range)', () => {
    expect(() =>
      resolveTransportMode({ WORKRAIL_TRANSPORT: 'http', WORKRAIL_HTTP_PORT: '99999' })
    ).toThrow('Invalid WORKRAIL_HTTP_PORT: "99999"');
  });

  it('accepts port 1 (minimum valid port)', () => {
    const mode = resolveTransportMode({
      WORKRAIL_TRANSPORT: 'http',
      WORKRAIL_HTTP_PORT: '1',
    });
    expect(mode).toEqual({ kind: 'http', port: 1 });
  });

  it('accepts port 65535 (maximum valid port)', () => {
    const mode = resolveTransportMode({
      WORKRAIL_TRANSPORT: 'http',
      WORKRAIL_HTTP_PORT: '65535',
    });
    expect(mode).toEqual({ kind: 'http', port: 65535 });
  });
});
