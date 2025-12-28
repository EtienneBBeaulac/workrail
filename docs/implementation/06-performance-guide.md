# Performance Guide

>  **Performance best practices and optimization strategies**

> **Note (WorkRail v1 vs v2):** This document includes v1-era MCP tool names in some examples (e.g., `workflow_next`). WorkRail v2 uses `start_workflow` / `continue_workflow` with opaque tokens; for v2 canonical behavior see `docs/reference/workflow-execution-contract.md` and `docs/design/v2-core-design-locks.md`.

[![Status](https://img.shields.io/badge/status-specification-orange.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)

##  Table of Contents

1. [Performance Philosophy](#performance-philosophy)
2. [Performance Targets](#performance-targets)
3. [Caching Strategy](#caching-strategy)
4. [Database Optimization](#database-optimization)
5. [Memory Management](#memory-management)
6. [Concurrency & Async](#concurrency--async)
7. [Monitoring & Metrics](#monitoring--metrics)
8. [Load Testing](#load-testing)
9. [Performance Tuning](#performance-tuning)

---

##  Important Note

**This is a specification project.** The performance strategies described below are the planned approach for when implementation begins. Currently, no actual performance optimizations are implemented - only the performance framework design.

For now, you can:
- Review the [Architecture Guide](02-architecture.md) to understand the system design
- Study the [API Specification](../spec/mcp-api-v1.0.md) to understand the interface
- Examine the [Workflow Schema](../spec/workflow.schema.json) to understand data structures

---

## Performance Philosophy

### Core Principles

1. **Measure First**: Profile before optimizing
2. **Optimize Critical Path**: Focus on bottlenecks
3. **Cache Intelligently**: Reduce redundant work
4. **Scale Horizontally**: Add resources as needed
5. **Monitor Continuously**: Track performance metrics

### Performance Goals

- **Response Time**: < 200ms for workflow operations
- **Throughput**: 1000+ requests per second
- **Memory Usage**: < 100MB for typical workloads
- **CPU Usage**: < 50% under normal load
- **Scalability**: Linear scaling with resources

---

## Performance Targets

### Response Time Targets

```typescript
// performance/targets.ts
export const performanceTargets = {
  workflowList: {
    p50: 50,    // 50ms
    p95: 100,   // 100ms
    p99: 200    // 200ms
  },
  workflowGet: {
    p50: 30,    // 30ms
    p95: 80,    // 80ms
    p99: 150    // 150ms
  },
  workflowNext: {
    p50: 100,   // 100ms
    p95: 200,   // 200ms
    p99: 400    // 400ms
  },
  workflowValidate: {
    p50: 50,    // 50ms
    p95: 120,   // 120ms
    p99: 250    // 250ms
  }
};
```

### Throughput Targets

```typescript
// performance/throughput.ts
export const throughputTargets = {
  concurrentUsers: 1000,
  requestsPerSecond: 1000,
  maxMemoryUsage: 100 * 1024 * 1024, // 100MB
  maxCPUUsage: 50 // 50%
};
```

---

## Caching Strategy

### Multi-Level Caching

```typescript
// performance/caching/multi-level-cache.ts
export class MultiLevelCache {
  private l1Cache = new Map<string, CacheEntry>(); // In-memory
  private l2Cache = new RedisCache(); // Redis
  private l3Cache = new FileSystemCache(); // Disk
  
  async get<T>(key: string): Promise<T | null> {
    // L1 Cache (Fastest)
    const l1Result = this.l1Cache.get(key);
    if (l1Result && !this.isExpired(l1Result)) {
      this.updateAccessTime(key);
      return l1Result.data as T;
    }
    
    // L2 Cache (Redis)
    const l2Result = await this.l2Cache.get(key);
    if (l2Result) {
      this.l1Cache.set(key, {
        data: l2Result.data,
        timestamp: Date.now(),
        ttl: 5 * 60 * 1000 // 5 minutes
      });
      return l2Result.data as T;
    }
    
    // L3 Cache (Disk)
    const l3Result = await this.l3Cache.get(key);
    if (l3Result) {
      // Populate L1 and L2
      await this.l2Cache.set(key, l3Result.data, 30 * 60 * 1000); // 30 minutes
      this.l1Cache.set(key, {
        data: l3Result.data,
        timestamp: Date.now(),
        ttl: 5 * 60 * 1000
      });
      return l3Result.data as T;
    }
    
    return null;
  }
  
  async set<T>(key: string, data: T, ttl: number = 5 * 60 * 1000): Promise<void> {
    // Set in all levels
    this.l1Cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
    
    await this.l2Cache.set(key, data, ttl);
    await this.l3Cache.set(key, data, ttl);
  }
  
  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }
  
  private updateAccessTime(key: string): void {
    const entry = this.l1Cache.get(key);
    if (entry) {
      entry.timestamp = Date.now();
    }
  }
}
```

### Intelligent Cache Invalidation

```typescript
// performance/caching/cache-invalidator.ts
export class CacheInvalidator {
  private invalidationPatterns = new Map<string, string[]>();
  
  constructor() {
    this.setupInvalidationPatterns();
  }
  
  private setupInvalidationPatterns(): void {
    // When a workflow is updated, invalidate related caches
    this.invalidationPatterns.set('workflow:update', [
      'workflow:list:*',
      'workflow:get:*',
      'workflow:search:*'
    ]);
    
    // When a step is completed, invalidate next step cache
    this.invalidationPatterns.set('step:complete', [
      'workflow:next:*',
      'workflow:progress:*'
    ]);
  }
  
  async invalidate(pattern: string): Promise<void> {
    const patterns = this.invalidationPatterns.get(pattern) || [];
    
    for (const invalidationPattern of patterns) {
      await this.invalidateByPattern(invalidationPattern);
    }
  }
  
  private async invalidateByPattern(pattern: string): Promise<void> {
    // Implementation depends on cache backend
    // For Redis: SCAN + DEL
    // For in-memory: filter keys + delete
  }
}
```

### Cache Warming

```typescript
// performance/caching/cache-warmer.ts
export class CacheWarmer {
  async warmPopularWorkflows(): Promise<void> {
    const popularWorkflows = [
      'simple-auth-implementation',
      'api-development',
      'database-setup',
      'testing-strategy'
    ];
    
    const warmPromises = popularWorkflows.map(async (workflowId) => {
      try {
        const workflow = await this.workflowStorage.getWorkflow(workflowId);
        await this.cache.set(`workflow:${workflowId}`, workflow, 60 * 60 * 1000); // 1 hour
      } catch (error) {
        console.warn(`Failed to warm cache for workflow: ${workflowId}`);
      }
    });
    
    await Promise.all(warmPromises);
  }
  
  async warmWorkflowList(): Promise<void> {
    try {
      const workflows = await this.workflowStorage.listWorkflows();
      await this.cache.set('workflow:list:all', workflows, 30 * 60 * 1000); // 30 minutes
    } catch (error) {
      console.warn('Failed to warm workflow list cache');
    }
  }
}
```

---

## Database Optimization

### Query Optimization

```typescript
// performance/database/query-optimizer.ts
export class QueryOptimizer {
  optimizeWorkflowQuery(filters: WorkflowFilters): OptimizedQuery {
    const query = {
      select: ['id', 'name', 'description', 'created_at'],
      where: [],
      orderBy: 'created_at DESC',
      limit: 50
    };
    
    // Add filters efficiently
    if (filters.category) {
      query.where.push(`category = '${filters.category}'`);
    }
    
    if (filters.search) {
      query.where.push(`(name LIKE '%${filters.search}%' OR description LIKE '%${filters.search}%')`);
    }
    
    // Use indexes effectively
    if (filters.category && filters.search) {
      query.orderBy = 'category, name'; // Use composite index
    }
    
    return query;
  }
  
  optimizeStepQuery(workflowId: string, stepId: string): OptimizedQuery {
    return {
      select: ['id', 'title', 'prompt', 'require_confirmation'],
      where: [`workflow_id = '${workflowId}'`, `id = '${stepId}'`],
      orderBy: 'sequence_number',
      limit: 1
    };
  }
}
```

### Connection Pooling

```typescript
// performance/database/connection-pool.ts
export class DatabaseConnectionPool {
  private pool: Pool;
  
  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 20, // Maximum connections
      min: 5,  // Minimum connections
      idle: 10000, // Close idle connections after 10 seconds
      acquireTimeoutMillis: 30000, // 30 seconds
      createTimeoutMillis: 30000,
      destroyTimeoutMillis: 5000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200
    });
  }
  
  async getConnection(): Promise<PoolClient> {
    return this.pool.connect();
  }
  
  async query(text: string, params: any[] = []): Promise<QueryResult> {
    const client = await this.getConnection();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }
  
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getConnection();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

### Index Strategy

```sql
-- performance/database/indexes.sql

-- Primary indexes
CREATE INDEX idx_workflows_id ON workflows(id);
CREATE INDEX idx_workflows_category ON workflows(category);
CREATE INDEX idx_workflows_created_at ON workflows(created_at);

-- Composite indexes for common queries
CREATE INDEX idx_workflows_category_created ON workflows(category, created_at);
CREATE INDEX idx_workflows_name_description ON workflows(name, description);

-- Full-text search index
CREATE INDEX idx_workflows_search ON workflows USING gin(to_tsvector('english', name || ' ' || description));

-- Steps indexes
CREATE INDEX idx_steps_workflow_id ON steps(workflow_id);
CREATE INDEX idx_steps_sequence ON steps(workflow_id, sequence_number);

-- Performance monitoring indexes
CREATE INDEX idx_performance_metrics_timestamp ON performance_metrics(timestamp);
CREATE INDEX idx_performance_metrics_operation ON performance_metrics(operation, timestamp);
```

---

## Memory Management

### Memory Pool

```typescript
// performance/memory/memory-pool.ts
export class MemoryPool {
  private pools = new Map<string, any[]>();
  private maxPoolSize = 100;
  
  get<T>(type: string): T {
    const pool = this.pools.get(type) || [];
    
    if (pool.length > 0) {
      return pool.pop() as T;
    }
    
    return this.createNew<T>(type);
  }
  
  release<T>(type: string, object: T): void {
    const pool = this.pools.get(type) || [];
    
    if (pool.length < this.maxPoolSize) {
      this.resetObject(object);
      pool.push(object);
      this.pools.set(type, pool);
    }
  }
  
  private createNew<T>(type: string): T {
    switch (type) {
      case 'Workflow':
        return new Workflow() as T;
      case 'WorkflowStep':
        return new WorkflowStep() as T;
      case 'ValidationResult':
        return new ValidationResult() as T;
      default:
        throw new Error(`Unknown type: ${type}`);
    }
  }
  
  private resetObject(object: any): void {
    // Reset object to initial state
    if (object.reset) {
      object.reset();
    } else {
      // Clear all properties
      for (const key in object) {
        if (object.hasOwnProperty(key)) {
          delete object[key];
        }
      }
    }
  }
}
```

### Garbage Collection Optimization

```typescript
// performance/memory/gc-optimizer.ts
export class GCOptimizer {
  private gcStats = {
    collections: 0,
    totalTime: 0,
    averageTime: 0
  };
  
  constructor() {
    this.setupGCMonitoring();
  }
  
  private setupGCMonitoring(): void {
    if (global.gc) {
      // Monitor garbage collection
      const gc = require('gc-stats')();
      
      gc.on('stats', (stats: any) => {
        this.gcStats.collections++;
        this.gcStats.totalTime += stats.pause;
        this.gcStats.averageTime = this.gcStats.totalTime / this.gcStats.collections;
        
        // Log if GC is taking too long
        if (stats.pause > 100) {
          console.warn(`Long GC pause: ${stats.pause}ms`);
        }
      });
    }
  }
  
  optimizeMemoryUsage(): void {
    // Clear caches periodically
    this.clearExpiredCacheEntries();
    
    // Release unused objects
    this.releaseUnusedObjects();
    
    // Force garbage collection if needed
    if (this.shouldForceGC()) {
      this.forceGC();
    }
  }
  
  private shouldForceGC(): boolean {
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    const heapTotal = memUsage.heapTotal;
    
    // Force GC if heap usage is high
    return (heapUsed / heapTotal) > 0.8;
  }
  
  private forceGC(): void {
    if (global.gc) {
      global.gc();
    }
  }
}
```

---

## Concurrency & Async

### Async Request Handling

```typescript
// performance/concurrency/async-handler.ts
export class AsyncRequestHandler {
  private requestQueue = new Map<string, Promise<any>>();
  private maxConcurrentRequests = 100;
  private activeRequests = 0;
  
  async handleRequest<T>(
    requestId: string,
    handler: () => Promise<T>
  ): Promise<T> {
    // Check if request is already being processed
    const existingRequest = this.requestQueue.get(requestId);
    if (existingRequest) {
      return existingRequest;
    }
    
    // Check concurrency limits
    if (this.activeRequests >= this.maxConcurrentRequests) {
      throw new Error('Too many concurrent requests');
    }
    
    // Create new request
    const requestPromise = this.executeRequest(handler);
    this.requestQueue.set(requestId, requestPromise);
    
    try {
      const result = await requestPromise;
      return result;
    } finally {
      this.requestQueue.delete(requestId);
    }
  }
  
  private async executeRequest<T>(handler: () => Promise<T>): Promise<T> {
    this.activeRequests++;
    
    try {
      return await handler();
    } finally {
      this.activeRequests--;
    }
  }
}
```

### Worker Threads

```typescript
// performance/concurrency/worker-manager.ts
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

export class WorkerManager {
  private workers: Worker[] = [];
  private maxWorkers = 4;
  
  constructor() {
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = new Worker('./dist/workers/workflow-worker.js');
      
      worker.on('message', (result) => {
        this.handleWorkerResult(result);
      });
      
      worker.on('error', (error) => {
        console.error('Worker error:', error);
        this.restartWorker(worker);
      });
      
      this.workers.push(worker);
    }
  }
  
  async processWorkflow(workflowId: string, context: any): Promise<any> {
    const worker = this.getAvailableWorker();
    
    return new Promise((resolve, reject) => {
      const messageId = this.generateMessageId();
      
      const timeout = setTimeout(() => {
        reject(new Error('Worker timeout'));
      }, 30000); // 30 seconds
      
      worker.once('message', (result) => {
        clearTimeout(timeout);
        if (result.id === messageId) {
          resolve(result.data);
        }
      });
      
      worker.postMessage({
        id: messageId,
        type: 'process_workflow',
        workflowId,
        context
      });
    });
  }
  
  private getAvailableWorker(): Worker {
    // Simple round-robin for now
    // In production, implement proper load balancing
    return this.workers[Math.floor(Math.random() * this.workers.length)];
  }
}

// Worker implementation
if (!isMainThread) {
  const { workflowId, context } = workerData;
  
  // Process workflow in worker thread
  processWorkflow(workflowId, context).then((result) => {
    parentPort?.postMessage({
      id: workerData.messageId,
      data: result
    });
  }).catch((error) => {
    parentPort?.postMessage({
      id: workerData.messageId,
      error: error.message
    });
  });
}
```

### Rate Limiting

```typescript
// performance/concurrency/rate-limiter.ts
export class RateLimiter {
  private requests = new Map<string, RequestRecord[]>();
  private readonly windowMs = 60 * 1000; // 1 minute
  private readonly maxRequests = 100; // per window
  
  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const clientRequests = this.requests.get(clientId) || [];
    
    // Remove old requests outside the window
    const recentRequests = clientRequests.filter(
      req => now - req.timestamp < this.windowMs
    );
    
    if (recentRequests.length >= this.maxRequests) {
      return false;
    }
    
    // Add current request
    recentRequests.push({ timestamp: now });
    this.requests.set(clientId, recentRequests);
    
    return true;
  }
  
  getRemainingRequests(clientId: string): number {
    const now = Date.now();
    const clientRequests = this.requests.get(clientId) || [];
    const recentRequests = clientRequests.filter(
      req => now - req.timestamp < this.windowMs
    );
    
    return Math.max(0, this.maxRequests - recentRequests.length);
  }
  
  getResetTime(clientId: string): number {
    const clientRequests = this.requests.get(clientId) || [];
    if (clientRequests.length === 0) {
      return Date.now();
    }
    
    const oldestRequest = Math.min(...clientRequests.map(req => req.timestamp));
    return oldestRequest + this.windowMs;
  }
}
```

---

## Monitoring & Metrics

### Performance Metrics

```typescript
// performance/monitoring/metrics.ts
export class PerformanceMetrics {
  private metrics = new Map<string, MetricData>();
  
  recordMetric(operation: string, duration: number, success: boolean): void {
    const metric = this.metrics.get(operation) || {
      count: 0,
      totalDuration: 0,
      minDuration: Infinity,
      maxDuration: 0,
      errors: 0,
      percentiles: new Array(100).fill(0)
    };
    
    metric.count++;
    metric.totalDuration += duration;
    metric.minDuration = Math.min(metric.minDuration, duration);
    metric.maxDuration = Math.max(metric.maxDuration, duration);
    
    if (!success) {
      metric.errors++;
    }
    
    // Update percentiles
    const percentileIndex = Math.floor(duration / 10); // 10ms buckets
    if (percentileIndex < 100) {
      metric.percentiles[percentileIndex]++;
    }
    
    this.metrics.set(operation, metric);
  }
  
  getMetrics(operation?: string): MetricReport {
    if (operation) {
      const metric = this.metrics.get(operation);
      return metric ? this.formatMetric(operation, metric) : null;
    }
    
    const report: MetricReport = {};
    for (const [op, metric] of this.metrics) {
      report[op] = this.formatMetric(op, metric);
    }
    
    return report;
  }
  
  private formatMetric(operation: string, metric: MetricData): OperationMetrics {
    const avgDuration = metric.totalDuration / metric.count;
    const errorRate = (metric.errors / metric.count) * 100;
    
    return {
      operation,
      count: metric.count,
      averageDuration: avgDuration,
      minDuration: metric.minDuration,
      maxDuration: metric.maxDuration,
      errorRate,
      p50: this.calculatePercentile(metric.percentiles, 50),
      p95: this.calculatePercentile(metric.percentiles, 95),
      p99: this.calculatePercentile(metric.percentiles, 99)
    };
  }
  
  private calculatePercentile(percentiles: number[], target: number): number {
    const total = percentiles.reduce((sum, count) => sum + count, 0);
    const targetCount = Math.floor((total * target) / 100);
    
    let currentCount = 0;
    for (let i = 0; i < percentiles.length; i++) {
      currentCount += percentiles[i];
      if (currentCount >= targetCount) {
        return i * 10; // Convert back to milliseconds
      }
    }
    
    return 0;
  }
}
```

### Health Checks

```typescript
// performance/monitoring/health-check.ts
export class HealthChecker {
  async performHealthCheck(): Promise<HealthStatus> {
    const checks = [
      this.checkDatabase(),
      this.checkCache(),
      this.checkMemory(),
      this.checkCPU(),
      this.checkDisk()
    ];
    
    const results = await Promise.all(checks);
    
    const overallStatus = results.every(result => result.status === 'healthy') 
      ? 'healthy' 
      : 'unhealthy';
    
    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks: results
    };
  }
  
  private async checkDatabase(): Promise<HealthCheck> {
    try {
      const startTime = Date.now();
      await this.database.query('SELECT 1');
      const duration = Date.now() - startTime;
      
      return {
        name: 'database',
        status: duration < 100 ? 'healthy' : 'degraded',
        duration,
        details: { queryTime: duration }
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        error: error.message
      };
    }
  }
  
  private async checkCache(): Promise<HealthCheck> {
    try {
      const startTime = Date.now();
      await this.cache.get('health-check');
      const duration = Date.now() - startTime;
      
      return {
        name: 'cache',
        status: duration < 50 ? 'healthy' : 'degraded',
        duration,
        details: { responseTime: duration }
      };
    } catch (error) {
      return {
        name: 'cache',
        status: 'unhealthy',
        error: error.message
      };
    }
  }
  
  private checkMemory(): HealthCheck {
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    const heapTotal = memUsage.heapTotal;
    const usagePercent = (heapUsed / heapTotal) * 100;
    
    return {
      name: 'memory',
      status: usagePercent < 80 ? 'healthy' : 'degraded',
      details: {
        heapUsed: Math.round(heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(heapTotal / 1024 / 1024) + 'MB',
        usagePercent: Math.round(usagePercent) + '%'
      }
    };
  }
}
```

---

## Load Testing

### Load Test Scenarios

```typescript
// performance/load/load-tester.ts
export class LoadTester {
  async runLoadTest(scenario: LoadTestScenario): Promise<LoadTestResult> {
    const startTime = Date.now();
    const results: RequestResult[] = [];
    
    // Create virtual users
    const virtualUsers = this.createVirtualUsers(scenario.userCount);
    
    // Run test for specified duration
    const testPromises = virtualUsers.map(async (user) => {
      return this.runUserScenario(user, scenario.duration);
    });
    
    const userResults = await Promise.all(testPromises);
    
    // Aggregate results
    const allResults = userResults.flat();
    const endTime = Date.now();
    
    return this.analyzeResults(allResults, startTime, endTime);
  }
  
  private createVirtualUsers(count: number): VirtualUser[] {
    const users: VirtualUser[] = [];
    
    for (let i = 0; i < count; i++) {
      users.push({
        id: `user-${i}`,
        sessionId: `session-${i}`,
        thinkTime: Math.random() * 2000 + 1000 // 1-3 seconds
      });
    }
    
    return users;
  }
  
  private async runUserScenario(user: VirtualUser, duration: number): Promise<RequestResult[]> {
    const results: RequestResult[] = [];
    const endTime = Date.now() + duration;
    
    while (Date.now() < endTime) {
      const request = this.generateRequest(user);
      const startTime = Date.now();
      
      try {
        const response = await this.executeRequest(request);
        const responseTime = Date.now() - startTime;
        
        results.push({
          user: user.id,
          request: request.type,
          responseTime,
          success: true,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        const responseTime = Date.now() - startTime;
        
        results.push({
          user: user.id,
          request: request.type,
          responseTime,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
      
      // Think time between requests
      await this.sleep(user.thinkTime);
    }
    
    return results;
  }
  
  private generateRequest(user: VirtualUser): LoadTestRequest {
    const requestTypes = [
      { type: 'workflow_list', weight: 0.4 },
      { type: 'workflow_get', weight: 0.3 },
      { type: 'workflow_next', weight: 0.2 },
      { type: 'workflow_validate', weight: 0.1 }
    ];
    
    const random = Math.random();
    let cumulativeWeight = 0;
    
    for (const requestType of requestTypes) {
      cumulativeWeight += requestType.weight;
      if (random <= cumulativeWeight) {
        return {
          type: requestType.type,
          params: this.generateParams(requestType.type, user)
        };
      }
    }
    
    return { type: 'workflow_list', params: {} };
  }
  
  private analyzeResults(results: RequestResult[], startTime: number, endTime: number): LoadTestResult {
    const successfulRequests = results.filter(r => r.success);
    const failedRequests = results.filter(r => !r.success);
    
    const responseTimes = successfulRequests.map(r => r.responseTime);
    responseTimes.sort((a, b) => a - b);
    
    return {
      totalRequests: results.length,
      successfulRequests: successfulRequests.length,
      failedRequests: failedRequests.length,
      successRate: (successfulRequests.length / results.length) * 100,
      averageResponseTime: responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length,
      p50ResponseTime: responseTimes[Math.floor(responseTimes.length * 0.5)],
      p95ResponseTime: responseTimes[Math.floor(responseTimes.length * 0.95)],
      p99ResponseTime: responseTimes[Math.floor(responseTimes.length * 0.99)],
      minResponseTime: Math.min(...responseTimes),
      maxResponseTime: Math.max(...responseTimes),
      requestsPerSecond: results.length / ((endTime - startTime) / 1000),
      testDuration: endTime - startTime
    };
  }
}
```

---

## Performance Tuning

### Configuration Optimization

```typescript
// performance/tuning/config-optimizer.ts
export class ConfigOptimizer {
  optimizeForEnvironment(environment: string): PerformanceConfig {
    const baseConfig = this.getBaseConfig();
    
    switch (environment) {
      case 'development':
        return {
          ...baseConfig,
          cacheEnabled: false,
          maxConcurrentRequests: 10,
          logLevel: 'debug'
        };
        
      case 'staging':
        return {
          ...baseConfig,
          cacheEnabled: true,
          maxConcurrentRequests: 50,
          logLevel: 'info'
        };
        
      case 'production':
        return {
          ...baseConfig,
          cacheEnabled: true,
          maxConcurrentRequests: 200,
          logLevel: 'warn',
          enableCompression: true,
          enableGzip: true
        };
        
      default:
        return baseConfig;
    }
  }
  
  private getBaseConfig(): PerformanceConfig {
    return {
      cacheEnabled: true,
      maxConcurrentRequests: 100,
      logLevel: 'info',
      enableCompression: false,
      enableGzip: false,
      cacheTTL: 5 * 60 * 1000, // 5 minutes
      rateLimitWindow: 60 * 1000, // 1 minute
      rateLimitMax: 100,
      databasePoolSize: 10,
      workerThreads: 4
    };
  }
}
```

### Auto-Scaling

```typescript
// performance/tuning/auto-scaler.ts
export class AutoScaler {
  private readonly scalingRules: ScalingRule[] = [
    {
      metric: 'cpu_usage',
      threshold: 70,
      action: 'scale_up',
      cooldown: 300000 // 5 minutes
    },
    {
      metric: 'cpu_usage',
      threshold: 30,
      action: 'scale_down',
      cooldown: 600000 // 10 minutes
    },
    {
      metric: 'memory_usage',
      threshold: 80,
      action: 'scale_up',
      cooldown: 300000
    },
    {
      metric: 'response_time',
      threshold: 500, // 500ms
      action: 'scale_up',
      cooldown: 300000
    }
  ];
  
  async checkScaling(): Promise<ScalingDecision> {
    const metrics = await this.getCurrentMetrics();
    
    for (const rule of this.scalingRules) {
      const metricValue = metrics[rule.metric];
      
      if (metricValue > rule.threshold) {
        const lastAction = this.getLastAction(rule.action);
        
        if (!lastAction || (Date.now() - lastAction.timestamp) > rule.cooldown) {
          return {
            action: rule.action,
            reason: `${rule.metric} exceeded threshold (${metricValue} > ${rule.threshold})`,
            timestamp: new Date().toISOString()
          };
        }
      }
    }
    
    return { action: 'none', reason: 'No scaling needed' };
  }
  
  async executeScaling(decision: ScalingDecision): Promise<void> {
    if (decision.action === 'scale_up') {
      await this.scaleUp();
    } else if (decision.action === 'scale_down') {
      await this.scaleDown();
    }
  }
  
  private async scaleUp(): Promise<void> {
    // Add more workers/instances
    const currentWorkers = this.getCurrentWorkerCount();
    const newWorkers = Math.min(currentWorkers * 2, this.maxWorkers);
    
    await this.addWorkers(newWorkers - currentWorkers);
  }
  
  private async scaleDown(): Promise<void> {
    // Reduce workers/instances
    const currentWorkers = this.getCurrentWorkerCount();
    const newWorkers = Math.max(currentWorkers / 2, this.minWorkers);
    
    await this.removeWorkers(currentWorkers - newWorkers);
  }
}
```

---

## Next Steps

This performance guide provides comprehensive optimization strategies. To continue:

1. **Understand Deployment**: Read [07-deployment-guide.md](07-deployment-guide.md)
2. **Explore the Codebase**: Review the [Architecture Guide](02-architecture.md)
3. **Advanced Performance**: Read [Advanced Performance](../advanced/performance.md)
4. **Reference Materials**: Read [Performance Reference](../reference/performance.md)

For performance best practices, see the [Performance Reference](../reference/performance.md) section.

---

**Need help with performance?** Check the [Troubleshooting Guide](../reference/troubleshooting.md) or create an issue on GitHub. 