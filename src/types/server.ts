export interface WorkflowLookupServer {
  start(): Promise<void>;
  stop(): Promise<void>;
} 