import { Readable, Writable } from 'stream';
import { ErrorHandler } from '../../core/error-handler';
import { JSONRPCRequest, JSONRPCResponse } from '../../types/mcp-types';

/**
 * RpcHandler encapsulates pure JSON-RPC 2.0 stdin/stdout (or arbitrary stream) handling.
 * It is transport-only: it parses newline-delimited JSON-RPC messages, delegates
 * execution to an injected dispatcher, and writes responses. It knows nothing
 * about domain logic.
 */
export class RpcHandler {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly dispatch: (
    method: string,
    params: any,
    id: string | number | null
  ) => Promise<any>;

  private running = false;
  private buffer = '';
  private listener: ((chunk: Buffer) => void) | null = null;

  constructor(
    dispatch: (
      method: string,
      params: any,
      id: string | number | null
    ) => Promise<any>,
    options?: {
      input?: Readable;
      output?: Writable;
    }
  ) {
    this.dispatch = dispatch;
    this.input = options?.input ?? process.stdin;
    this.output = options?.output ?? process.stdout;
  }

  /** Attach listeners and begin processing */
  start(): void {
    if (this.running) return;

    this.listener = (chunk: Buffer) => {
      this.buffer += chunk.toString();

      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const raw = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!raw) continue;
        this.processLine(raw);
      }
    };

    this.input.on('data', this.listener);
    this.running = true;
  }

  /** Detach listeners to stop processing */
  stop(): void {
    if (!this.running) return;
    if (this.listener) {
      this.input.off('data', this.listener);
      this.listener = null;
    }
    this.running = false;
  }

  private async processLine(raw: string): Promise<void> {
    const errorHandler = ErrorHandler.getInstance();

    let request: JSONRPCRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      const errorResponse = errorHandler.createParseError();
      this.writeResponse(errorResponse);
      return;
    }

    // Basic JSON-RPC 2.0 request validation
    const validStructure =
      request &&
      request.jsonrpc === '2.0' &&
      typeof request.method === 'string' &&
      (typeof request.id === 'string' || typeof request.id === 'number' || request.id === null);

    if (!validStructure) {
      const invalid = errorHandler.createInvalidRequestError((request as any)?.id ?? null);
      this.writeResponse(invalid);
      return;
    }

    try {
      const result = await this.dispatch(request.method, request.params, request.id);
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
      this.writeResponse(response);
    } catch (err) {
      const errorResponse = errorHandler.handleError(err as Error, request.id);
      this.writeResponse(errorResponse);
    }
  }

  private writeResponse(response: JSONRPCResponse): void {
    this.output.write(JSON.stringify(response) + '\n');
  }
} 