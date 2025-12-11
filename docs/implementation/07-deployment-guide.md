# Deployment Guide

>  **Deployment Strategies and Operations for the WorkRail System**

[![Status](https://img.shields.io/badge/status-specification-orange.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)

##  Table of Contents

1. [Deployment Overview](#deployment-overview)
2. [Environment Setup](#environment-setup)
3. [Deployment Strategies](#deployment-strategies)
4. [Configuration Management](#configuration-management)
5. [Monitoring & Logging](#monitoring--logging)
6. [Backup & Recovery](#backup--recovery)
7. [Security Considerations](#security-considerations)
8. [Troubleshooting](#troubleshooting)

---

##  Important Note

**This is a specification project.** The deployment strategies described below are the planned approach for when implementation begins. Currently, no actual deployment infrastructure exists - only the deployment framework design.

For now, you can:
- Review the [Architecture Guide](02-architecture.md) to understand the system design
- Study the [API Specification](../spec/mcp-api-v1.0.md) to understand the interface
- Examine the [Workflow Schema](../spec/workflow.schema.json) to understand data structures

---

## Deployment Overview

### Deployment Options

The WorkRail System supports multiple deployment strategies:

1. **Local Development**: Docker Compose or direct Node.js
2. **Single Server**: Traditional server deployment
3. **Container Orchestration**: Kubernetes or Docker Swarm
4. **Serverless**: Cloud functions (limited support)
5. **Edge Deployment**: Distributed edge nodes

### Deployment Architecture

```
┌─────────────────┐
│   Load Balancer │
└─────────┬───────┘
          │
    ┌─────▼─────┐
    │  MCP      │
    │  Server   │
    └─────┬─────┘
          │
    ┌─────▼─────┐
    │ Workflow  │
    │ Storage   │
    └───────────┘
```

---

## Environment Setup

### Prerequisites

```bash
# System requirements
Node.js 20+
Docker 20.10+
Kubernetes 1.24+ (for K8s deployment)
```

### Environment Variables

```bash
# Core configuration
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# MCP server configuration
MCP_SERVER_HOST=localhost
MCP_SERVER_PORT=3000

# Workflow storage
WORKFLOW_STORAGE_PATH=/data/workflows
WORKFLOW_STORAGE_TYPE=file

# Security settings
JWT_SECRET=your-secret-key
API_KEY=your-api-key
MAX_INPUT_SIZE=1048576
RATE_LIMIT_PER_MINUTE=100

# Performance settings
CACHE_TTL=300000
MAX_CONCURRENT_REQUESTS=1000
MEMORY_LIMIT=100MB

# Monitoring
LOG_LEVEL=info
METRICS_ENABLED=true
HEALTH_CHECK_INTERVAL=30000
```

---

## Deployment Strategies

### 1. Docker Deployment

#### Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY dist/ ./dist/
COPY workflows/ ./workflows/

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["node", "dist/index.js"]
```

#### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  workrail:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - WORKFLOW_STORAGE_PATH=/data/workflows
    volumes:
      - workflow-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  workflow-data:
```

### 2. Kubernetes Deployment

#### Deployment Manifest

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workrail
  labels:
    app: workrail
spec:
  replicas: 3
  selector:
    matchLabels:
      app: workrail
  template:
    metadata:
      labels:
        app: workrail
    spec:
      containers:
      - name: workrail
        image: workrail:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "3000"
        - name: WORKFLOW_STORAGE_PATH
          value: "/data/workflows"
        volumeMounts:
        - name: workflow-data
          mountPath: /data
        resources:
          requests:
            memory: "100Mi"
            cpu: "100m"
          limits:
            memory: "200Mi"
            cpu: "200m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: workflow-data
        persistentVolumeClaim:
          claimName: workflow-pvc
```

#### Service Manifest

```yaml
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: workrail-service
spec:
  selector:
    app: workrail
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: LoadBalancer
```

#### Ingress Manifest

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: workrail-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: workrail.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: workrail-service
            port:
              number: 80
```

### 3. Serverless Deployment

#### AWS Lambda

```typescript
// lambda/index.ts
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { MCPServer } from './mcp-server';

const server = new MCPServer();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const result = await server.handleRequest(event.body);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
```

#### Serverless Framework

```yaml
# serverless.yml
service: workrail

provider:
  name: aws
  runtime: nodejs20.x
  region: us-east-1
  environment:
    NODE_ENV: production
    WORKFLOW_STORAGE_PATH: /tmp/workflows

functions:
  mcp-server:
    handler: lambda/index.handler
    events:
      - http:
          path: /mcp
          method: post
    memorySize: 512
    timeout: 30
```

---

## Configuration Management

### Configuration Files

#### Production Config

```json
// config/production.json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "cors": {
      "origin": ["https://yourdomain.com"],
      "credentials": true
    }
  },
  "workflows": {
    "storage": {
      "type": "file",
      "path": "/data/workflows"
    },
    "validation": {
      "enabled": true,
      "strict": true
    }
  },
  "security": {
    "jwt": {
      "secret": "${JWT_SECRET}",
      "expiresIn": "24h"
    },
    "rateLimit": {
      "windowMs": 60000,
      "max": 100
    }
  },
  "performance": {
    "cache": {
      "enabled": true,
      "ttl": 300000
    },
    "compression": {
      "enabled": true,
      "level": 6
    }
  }
}
```

#### Environment-Specific Configs

```bash
# Development
cp config/development.json config/local.json

# Staging
cp config/staging.json config/local.json

# Production
cp config/production.json config/local.json
```

### Configuration Validation

```typescript
// config/validator.ts
import { z } from 'zod';

const ConfigSchema = z.object({
  server: z.object({
    port: z.number().min(1).max(65535),
    host: z.string(),
    cors: z.object({
      origin: z.array(z.string()),
      credentials: z.boolean()
    })
  }),
  workflows: z.object({
    storage: z.object({
      type: z.enum(['file', 'database']),
      path: z.string()
    }),
    validation: z.object({
      enabled: z.boolean(),
      strict: z.boolean()
    })
  }),
  security: z.object({
    jwt: z.object({
      secret: z.string().min(32),
      expiresIn: z.string()
    }),
    rateLimit: z.object({
      windowMs: z.number(),
      max: z.number()
    })
  }),
  performance: z.object({
    cache: z.object({
      enabled: z.boolean(),
      ttl: z.number()
    }),
    compression: z.object({
      enabled: z.boolean(),
      level: z.number().min(0).max(9)
    })
  })
});

export function validateConfig(config: unknown) {
  return ConfigSchema.parse(config);
}
```

---

## Monitoring & Logging

### Health Checks

```typescript
// monitoring/health-check.ts
export class HealthChecker {
  async checkHealth(): Promise<HealthStatus> {
    const checks = [
      this.checkServer(),
      this.checkStorage(),
      this.checkMemory(),
      this.checkDisk()
    ];
    
    const results = await Promise.allSettled(checks);
    
    return {
      status: results.every(r => r.status === 'fulfilled') ? 'healthy' : 'unhealthy',
      checks: results.map((result, index) => ({
        name: ['server', 'storage', 'memory', 'disk'][index],
        status: result.status === 'fulfilled' ? 'ok' : 'error',
        message: result.status === 'fulfilled' ? 'OK' : result.reason
      })),
      timestamp: new Date().toISOString()
    };
  }
  
  private async checkServer(): Promise<void> {
    // Check if server is responding
    const response = await fetch('http://localhost:3000/health');
    if (!response.ok) {
      throw new Error('Server not responding');
    }
  }
  
  private async checkStorage(): Promise<void> {
    // Check if workflow storage is accessible
    const fs = require('fs').promises;
    await fs.access(process.env.WORKFLOW_STORAGE_PATH);
  }
  
  private async checkMemory(): Promise<void> {
    const usage = process.memoryUsage();
    if (usage.heapUsed > 100 * 1024 * 1024) { // 100MB
      throw new Error('Memory usage too high');
    }
  }
  
  private async checkDisk(): Promise<void> {
    // Check disk space
    const fs = require('fs');
    const stats = fs.statSync(process.env.WORKFLOW_STORAGE_PATH);
    const freeSpace = stats.blocks * stats.blksize;
    if (freeSpace < 1024 * 1024 * 1024) { // 1GB
      throw new Error('Disk space low');
    }
  }
}
```

### Logging Configuration

```typescript
// logging/logger.ts
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'workrail' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}
```

### Metrics Collection

```typescript
// monitoring/metrics.ts
import { register, Counter, Histogram, Gauge } from 'prom-client';

export const metrics = {
  requestsTotal: new Counter({
    name: 'workflow_requests_total',
    help: 'Total number of workflow requests',
    labelNames: ['method', 'status']
  }),
  
  requestDuration: new Histogram({
    name: 'workflow_request_duration_seconds',
    help: 'Duration of workflow requests',
    labelNames: ['method']
  }),
  
  activeWorkflows: new Gauge({
    name: 'workflow_active_workflows',
    help: 'Number of active workflows'
  }),
  
  memoryUsage: new Gauge({
    name: 'workflow_memory_usage_bytes',
    help: 'Memory usage in bytes'
  })
};

// Enable metrics endpoint
register.metrics().then(metrics => {
  // Serve metrics at /metrics
});
```

---

## Backup & Recovery

### Backup Strategy

```typescript
// backup/backup-manager.ts
export class BackupManager {
  async createBackup(): Promise<BackupInfo> {
    const timestamp = new Date().toISOString();
    const backupPath = `/backups/workrail-${timestamp}.tar.gz`;
    
    // Create backup archive
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec(`tar -czf ${backupPath} -C /data workflows`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    
    return {
      path: backupPath,
      timestamp,
      size: await this.getFileSize(backupPath)
    };
  }
  
  async restoreBackup(backupPath: string): Promise<void> {
    // Stop server
    await this.stopServer();
    
    // Restore from backup
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec(`tar -xzf ${backupPath} -C /data`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    
    // Start server
    await this.startServer();
  }
  
  private async getFileSize(path: string): Promise<number> {
    const fs = require('fs').promises;
    const stats = await fs.stat(path);
    return stats.size;
  }
}
```

### Automated Backups

```bash
#!/bin/bash
# backup.sh

# Create daily backup
BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="workrail_${DATE}.tar.gz"

# Create backup
tar -czf "${BACKUP_DIR}/${BACKUP_FILE}" -C /data workflows

# Upload to cloud storage (optional)
aws s3 cp "${BACKUP_DIR}/${BACKUP_FILE}" s3://your-backup-bucket/

# Clean up old backups (keep last 7 days)
find "${BACKUP_DIR}" -name "workrail_*.tar.gz" -mtime +7 -delete
```

---

## Security Considerations

### Network Security

```typescript
// security/network-security.ts
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function configureSecurity(app: Express) {
  // Security headers
  app.use(helmet());
  
  // Rate limiting
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
  }));
  
  // CORS configuration
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true
  }));
  
  // Request size limiting
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb' }));
}
```

### SSL/TLS Configuration

```typescript
// security/ssl.ts
import https from 'https';
import fs from 'fs';

export function createHttpsServer(app: Express) {
  const options = {
    key: fs.readFileSync('/path/to/private-key.pem'),
    cert: fs.readFileSync('/path/to/certificate.pem'),
    ca: fs.readFileSync('/path/to/ca-bundle.pem')
  };
  
  return https.createServer(options, app);
}
```

---

## Troubleshooting

### Common Issues

#### 1. **Server Won't Start**

**Symptoms**: Server fails to start or crashes immediately

**Solutions**:
```bash
# Check port availability
lsof -i :3000

# Check Node.js version
node --version

# Check dependencies
npm install

# Check configuration
npm run validate-config
```

#### 2. **High Memory Usage**

**Symptoms**: Server consumes excessive memory

**Solutions**:
```bash
# Check memory usage
ps aux | grep node

# Enable garbage collection logging
node --trace-gc dist/index.js

# Increase memory limit
node --max-old-space-size=2048 dist/index.js
```

#### 3. **Slow Response Times**

**Symptoms**: Requests take too long to complete

**Solutions**:
```bash
# Check system resources
top
iostat

# Enable performance monitoring
export ENABLE_METRICS=true

# Check for memory leaks
npm run test:memory
```

#### 4. **Workflow Storage Issues**

**Symptoms**: Can't read or write workflows

**Solutions**:
```bash
# Check file permissions
ls -la /data/workflows/

# Check disk space
df -h

# Validate workflow files
npm run validate-workflows
```

### Debugging Tools

#### 1. **Log Analysis**

```bash
# View real-time logs
tail -f logs/combined.log

# Search for errors
grep ERROR logs/combined.log

# Analyze log patterns
npm run analyze-logs
```

#### 2. **Performance Profiling**

```bash
# CPU profiling
node --prof dist/index.js

# Memory profiling
node --inspect dist/index.js

# Load testing
npm run load-test
```

#### 3. **Network Diagnostics**

```bash
# Check connectivity
curl -v http://localhost:3000/health

# Test MCP protocol
npx @modelcontextprotocol/inspector

# Monitor network traffic
tcpdump -i lo0 port 3000
```

---

**Note**: This deployment guide describes the planned approach for when implementation begins. The actual deployment infrastructure will be developed according to this strategy during the implementation phase. 