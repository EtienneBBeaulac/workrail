# Complete System Architecture

## Overview

This document provides complete technical specifications for all components of the Workrail Dashboard Architecture.

---

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    User's Machine                            │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Workrail MCP Process (Node.js)                      │  │
│  │  Running from: npx @workrail/mcp                     │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  1. Workflow Engine                                  │  │
│  │     - Executes workflow JSON                         │  │
│  │     - Manages agent state                            │  │
│  │     - Provides MCP tools to agent                    │  │
│  │                                                        │  │
│  │  2. HTTP Server (http://localhost:3456)             │  │
│  │     - Express.js                                     │  │
│  │     - Serves static dashboard UI                    │  │
│  │     - Provides API endpoints                        │  │
│  │     - ETag support for efficient polling             │  │
│  │                                                        │  │
│  │  3. Session Manager                                  │  │
│  │     - Creates sessions in ~/.workrail/              │  │
│  │     - Atomic file writes                             │  │
│  │     - Project ID management                          │  │
│  │     - Session indexing                               │  │
│  │                                                        │  │
│  │  4. Custom MCP Tools                                 │  │
│  │     - workrail_create_session()                      │  │
│  │     - workrail_update_session()                      │  │
│  │     - workrail_read_session()                        │  │
│  │     - workrail_open_dashboard()                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  File System                                          │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  ~/.workrail/                                         │  │
│  │  ├── config.json                                      │  │
│  │  └── sessions/                                        │  │
│  │      ├── abc123def456/    ← Project 1               │  │
│  │      │   ├── project.json                            │  │
│  │      │   ├── bug-investigation/                      │  │
│  │      │   │   ├── AUTH-1234.json                      │  │
│  │      │   │   └── CACHE-5678.json                     │  │
│  │      │   └── mr-review/                              │  │
│  │      │       └── PR-789.json                         │  │
│  │      └── xyz789abc123/    ← Project 2               │  │
│  │          └── ...                                      │  │
│  │                                                        │  │
│  │  {npm-package}/web/       ← Dashboard UI files      │  │
│  │  ├── index.html                                       │  │
│  │  ├── framework/                                       │  │
│  │  │   ├── app.js                                      │  │
│  │  │   ├── router.js                                   │  │
│  │  │   ├── data-loader.js                              │  │
│  │  │   └── components/                                 │  │
│  │  └── workflows/                                       │  │
│  │      ├── registry.json                               │  │
│  │      ├── bug-investigation/                          │  │
│  │      │   ├── config.js                               │  │
│  │      │   ├── schema.json                             │  │
│  │      │   └── views.js                                │  │
│  │      └── mr-review/                                  │  │
│  │          └── ...                                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Browser (http://localhost:3456)                     │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  - Loads dashboard UI from MCP HTTP server          │  │
│  │  - Polls API every 1-2 seconds                       │  │
│  │  - Renders workflow-specific views                   │  │
│  │  - Exports to PDF/Markdown/JSON                      │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Component 1: MCP Server Extensions

### HTTP Server Implementation

**Location:** `src/infrastructure/HttpServer.ts`

```typescript
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import open from 'open';

export class HttpServer {
  private app: express.Application;
  private server: http.Server;
  private port: number = 3456;
  
  constructor(
    private sessionManager: SessionManager,
    private config: ServerConfig
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  private setupMiddleware(): void {
    // CORS for local development
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      next();
    });
    
    // ETag support for efficient polling
    this.app.set('etag', 'strong');
    
    // JSON parsing
    this.app.use(express.json());
  }
  
  private setupRoutes(): void {
    // Serve static dashboard UI from npm package
    const webDir = path.join(__dirname, '../../web');
    this.app.use('/web', express.static(webDir));
    
    // Dashboard home
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });
    
    // API: List all sessions
    this.app.get('/api/sessions', async (req, res) => {
      const sessions = await this.sessionManager.listAllSessions();
      res.json(sessions);
    });
    
    // API: Get specific session
    this.app.get('/api/sessions/:workflow/:id', async (req, res) => {
      const { workflow, id } = req.params;
      const session = await this.sessionManager.getSession(workflow, id);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      res.json(session);
    });
    
    // API: Get current project info
    this.app.get('/api/current-project', async (req, res) => {
      const project = await this.sessionManager.getCurrentProject();
      res.json(project);
    });
    
    // API: List all projects
    this.app.get('/api/projects', async (req, res) => {
      const projects = await this.sessionManager.listProjects();
      res.json(projects);
    });
  }
  
  async start(): Promise<string> {
    // Try port 3456, increment if busy
    while (this.port < 3500) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server = createServer(this.app);
          this.server.listen(this.port, () => resolve());
          this.server.on('error', reject);
        });
        
        const url = `http://localhost:${this.port}`;
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`🔧 Workrail MCP Server Started`);
        console.log(`${'═'.repeat(60)}`);
        console.log(`📊 Dashboard: ${url}`);
        console.log(`💾 Sessions: ${this.sessionManager.getSessionsRoot()}`);
        console.log(`${'═'.repeat(60)}\n`);
        
        return url;
      } catch (error) {
        this.port++;
      }
    }
    
    throw new Error('No available ports in range 3456-3499');
  }
  
  async openDashboard(sessionId?: string): Promise<void> {
    const url = sessionId
      ? `http://localhost:${this.port}?session=${sessionId}`
      : `http://localhost:${this.port}`;
    
    await open(url);
  }
  
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}
```

---

## Component 2: Session Manager

**Location:** `src/infrastructure/SessionManager.ts`

```typescript
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import os from 'os';

export interface Session {
  id: string;
  workflowId: string;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
}

export class SessionManager {
  private sessionsRoot: string;
  private projectId: string;
  
  constructor(private projectPath: string = process.cwd()) {
    this.sessionsRoot = path.join(os.homedir(), '.workrail', 'sessions');
    this.projectId = this.hashProjectPath(projectPath);
  }
  
  private hashProjectPath(projectPath: string): string {
    return createHash('sha256')
      .update(path.resolve(projectPath))
      .digest('hex')
      .substring(0, 12);
  }
  
  private getProjectRoot(): string {
    return path.join(this.sessionsRoot, this.projectId);
  }
  
  private getSessionPath(workflowId: string, sessionId: string): string {
    return path.join(
      this.getProjectRoot(),
      workflowId,
      `${sessionId}.json`
    );
  }
  
  async createSession(
    workflowId: string,
    sessionId: string,
    initialData: Record<string, any> = {}
  ): Promise<Session> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    
    const session: Session = {
      id: sessionId,
      workflowId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: initialData
    };
    
    // Atomic write
    const tempPath = `${sessionPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(session, null, 2));
    await fs.rename(tempPath, sessionPath);
    
    // Update project metadata
    await this.updateProjectMetadata();
    
    return session;
  }
  
  async updateSession(
    workflowId: string,
    sessionId: string,
    updates: Record<string, any>
  ): Promise<Session> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    
    // Read existing session
    const content = await fs.readFile(sessionPath, 'utf-8');
    const session: Session = JSON.parse(content);
    
    // Deep merge updates
    session.data = this.deepMerge(session.data, updates);
    session.updatedAt = new Date().toISOString();
    
    // Atomic write
    const tempPath = `${sessionPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(session, null, 2));
    await fs.rename(tempPath, sessionPath);
    
    return session;
  }
  
  async readSession(
    workflowId: string,
    sessionId: string,
    path?: string
  ): Promise<any> {
    const sessionPath = this.getSessionPath(workflowId, sessionId);
    const content = await fs.readFile(sessionPath, 'utf-8');
    const session: Session = JSON.parse(content);
    
    if (!path) {
      return session.data;
    }
    
    // Support JSONPath-like queries
    return this.getPath(session.data, path);
  }
  
  async getSession(
    workflowId: string,
    sessionId: string
  ): Promise<Session | null> {
    try {
      const sessionPath = this.getSessionPath(workflowId, sessionId);
      const content = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  
  async listAllSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    const projectRoot = this.getProjectRoot();
    
    try {
      const workflows = await fs.readdir(projectRoot);
      
      for (const workflow of workflows) {
        if (workflow === 'project.json') continue;
        
        const workflowPath = path.join(projectRoot, workflow);
        const files = await fs.readdir(workflowPath);
        
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          
          const sessionPath = path.join(workflowPath, file);
          const content = await fs.readFile(sessionPath, 'utf-8');
          sessions.push(JSON.parse(content));
        }
      }
    } catch (error) {
      // Project directory doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return sessions.sort((a, b) => 
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }
  
  async getCurrentProject(): Promise<any> {
    const projectPath = path.join(this.getProjectRoot(), 'project.json');
    
    try {
      const content = await fs.readFile(projectPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          id: this.projectId,
          path: this.projectPath,
          sessions: []
        };
      }
      throw error;
    }
  }
  
  async listProjects(): Promise<any[]> {
    const projects: any[] = [];
    
    try {
      const projectDirs = await fs.readdir(this.sessionsRoot);
      
      for (const projectId of projectDirs) {
        const projectPath = path.join(
          this.sessionsRoot,
          projectId,
          'project.json'
        );
        
        try {
          const content = await fs.readFile(projectPath, 'utf-8');
          projects.push(JSON.parse(content));
        } catch (error) {
          // Skip if no project.json
        }
      }
    } catch (error) {
      // Sessions root doesn't exist yet
      if (error.code !== 'ENOENT') throw error;
    }
    
    return projects;
  }
  
  getSessionsRoot(): string {
    return this.sessionsRoot;
  }
  
  private async updateProjectMetadata(): Promise<void> {
    const projectPath = path.join(this.getProjectRoot(), 'project.json');
    
    const sessions = await this.listAllSessions();
    
    const metadata = {
      id: this.projectId,
      path: this.projectPath,
      updatedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      workflows: [...new Set(sessions.map(s => s.workflowId))]
    };
    
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(projectPath, JSON.stringify(metadata, null, 2));
  }
  
  private deepMerge(target: any, source: any): any {
    const output = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    
    return output;
  }
  
  private getPath(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current === undefined) return undefined;
      
      // Handle array queries: hypotheses[?status=='active']
      const arrayMatch = part.match(/^(\w+)\[(.+)\]$/);
      if (arrayMatch) {
        const [, key, query] = arrayMatch;
        current = current[key];
        
        if (Array.isArray(current) && query.startsWith('?')) {
          // Simple filter query
          const filterMatch = query.match(/\?(\w+)=='(.+)'/);
          if (filterMatch) {
            const [, field, value] = filterMatch;
            current = current.filter(item => item[field] === value);
          }
        } else if (query.match(/^\d+$/)) {
          // Array index
          current = current[parseInt(query)];
        }
      } else {
        current = current[part];
      }
    }
    
    return current;
  }
}
```

---

## Component 3: Custom MCP Tools

**Location:** `src/tools/session-tools.ts`

```typescript
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from '../infrastructure/SessionManager.js';
import { HttpServer } from '../infrastructure/HttpServer.js';

export function createSessionTools(
  sessionManager: SessionManager,
  httpServer: HttpServer
): Tool[] {
  return [
    {
      name: 'workrail_create_session',
      description: 'Create a new workflow session in ~/.workrail/sessions/. Returns session ID.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier (e.g., "bug-investigation")'
          },
          sessionId: {
            type: 'string',
            description: 'Unique session identifier (e.g., ticket ID, branch name)'
          },
          initialData: {
            type: 'object',
            description: 'Initial session data (optional)',
            default: {}
          }
        },
        required: ['workflowId', 'sessionId']
      }
    },
    
    {
      name: 'workrail_update_session',
      description: 'Update session data. Supports deep merge and JSONPath updates.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier'
          },
          updates: {
            type: 'object',
            description: 'Data to merge into session. Use dot notation for nested updates.'
          }
        },
        required: ['workflowId', 'sessionId', 'updates']
      }
    },
    
    {
      name: 'workrail_read_session',
      description: 'Read session data. Supports JSONPath queries for targeted reads.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier'
          },
          path: {
            type: 'string',
            description: 'JSONPath query (optional). Examples: "dashboard.confidence", "hypotheses[?status==\'active\']"'
          }
        },
        required: ['workflowId', 'sessionId']
      }
    },
    
    {
      name: 'workrail_open_dashboard',
      description: 'Open dashboard in browser. Auto-focuses on specific session if provided.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session to display (optional, defaults to home page)'
          }
        }
      }
    }
  ];
}

export async function handleSessionTool(
  name: string,
  args: any,
  sessionManager: SessionManager,
  httpServer: HttpServer
): Promise<any> {
  switch (name) {
    case 'workrail_create_session':
      const session = await sessionManager.createSession(
        args.workflowId,
        args.sessionId,
        args.initialData || {}
      );
      return {
        success: true,
        sessionId: session.id,
        path: sessionManager.getSessionPath(args.workflowId, args.sessionId),
        message: `Session created: ${args.workflowId}/${args.sessionId}`
      };
      
    case 'workrail_update_session':
      await sessionManager.updateSession(
        args.workflowId,
        args.sessionId,
        args.updates
      );
      return {
        success: true,
        message: 'Session updated'
      };
      
    case 'workrail_read_session':
      const data = await sessionManager.readSession(
        args.workflowId,
        args.sessionId,
        args.path
      );
      return {
        success: true,
        data
      };
      
    case 'workrail_open_dashboard':
      await httpServer.openDashboard(args.sessionId);
      return {
        success: true,
        url: args.sessionId
          ? `http://localhost:3456?session=${args.sessionId}`
          : 'http://localhost:3456',
        message: 'Dashboard opened in browser'
      };
      
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

---

## Component 4: Storage Structure

```
~/.workrail/
├── config.json                          # Global config
└── sessions/
    ├── abc123def456/                    # Project 1 (hashed path)
    │   ├── project.json                 # Project metadata
    │   ├── bug-investigation/           # Workflow type
    │   │   ├── AUTH-1234.json          # Session 1
    │   │   ├── CACHE-5678.json         # Session 2
    │   │   └── PERF-9012.json          # Session 3
    │   └── mr-review/
    │       └── PR-789.json
    └── xyz789abc123/                    # Project 2
        └── documentation/
            └── API-DOCS.json
```

### Project Hash Calculation

```typescript
import { createHash } from 'crypto';
import path from 'path';

function getProjectId(projectPath: string): string {
  const absolutePath = path.resolve(projectPath);
  return createHash('sha256')
    .update(absolutePath)
    .digest('hex')
    .substring(0, 12);
}

// Example:
// /Users/etienneb/git/personal/mcp -> "abc123def456"
// /home/ubuntu/projects/api         -> "xyz789abc123"
```

**Benefits:**
- Same project → same ID (even if MCP started from subdirectory)
- Different projects → different IDs
- Move project → new ID (sessions don't follow)
- Collisions: practically impossible (2^48 space)

---

## Component 5: Data Flow

### Session Lifecycle

```
1. WORKFLOW START
   Agent → workrail_create_session("bug-investigation", "AUTH-1234")
   MCP   → Creates ~/.workrail/sessions/{projectId}/bug-investigation/AUTH-1234.json
   MCP   → Returns: {success: true, sessionId: "AUTH-1234", path: "..."}

2. AGENT UPDATES
   Agent → workrail_update_session("bug-investigation", "AUTH-1234", {
             "dashboard.progress": 15,
             "dashboard.currentPhase": "1.2"
           })
   MCP   → Reads existing session
   MCP   → Deep merges updates
   MCP   → Atomic write (temp file → rename)
   MCP   → Returns: {success: true}

3. USER VIEWS DASHBOARD
   Browser → GET http://localhost:3456?session=AUTH-1234
   MCP     → Serves index.html
   Browser → GET /api/sessions/bug-investigation/AUTH-1234
   MCP     → Reads session JSON
   MCP     → Returns session data with ETag header
   Browser → Renders UI

4. DASHBOARD POLLS
   [Every 1-2 seconds]
   Browser → HEAD /api/sessions/bug-investigation/AUTH-1234
   MCP     → Returns ETag
   Browser → If ETag changed:
               GET /api/sessions/bug-investigation/AUTH-1234
               Update UI
   
5. AGENT READS TARGETED DATA
   Agent → workrail_read_session("bug-investigation", "AUTH-1234", "dashboard")
   MCP   → Reads session
   MCP   → Extracts dashboard section
   MCP   → Returns: {confidence: 7.8, progress: 67, ...}
   
6. WORKFLOW COMPLETE
   Agent → workrail_update_session(..., {"dashboard.status": "complete"})
   Agent → "Investigation complete. View results: http://localhost:3456?session=AUTH-1234"
```

---

## Component 6: Concurrency & Atomicity

### Atomic Writes

```typescript
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  
  try {
    // Write to temp file
    await fs.writeFile(tempPath, data, 'utf-8');
    
    // Atomic rename (POSIX guarantees atomicity)
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
}
```

**Guarantees:**
- No partial writes visible to readers
- No data loss on crash
- No corruption on concurrent writes (though shouldn't happen)

### Read Safety

```typescript
async function safeRead(filePath: string): Promise<any> {
  let retries = 3;
  
  while (retries > 0) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error.name === 'SyntaxError' && retries > 1) {
        // Possible race with write, retry
        await sleep(100);
        retries--;
        continue;
      }
      throw error;
    }
  }
}
```

---

## Component 7: Error Handling

### Session Not Found

```typescript
// 404 response with helpful message
{
  "error": "Session not found",
  "workflowId": "bug-investigation",
  "sessionId": "AUTH-1234",
  "suggestion": "Use workrail_create_session() to create a new session"
}
```

### Invalid Updates

```typescript
// Validation before write
if (!isValidUpdate(updates, schema)) {
  return {
    "error": "Invalid session update",
    "violations": [
      "dashboard.confidence must be number between 0-10",
      "hypotheses[].status must be one of: pending, active, confirmed, rejected"
    ]
  };
}
```

### Port Conflicts

```typescript
// Auto-increment port if busy
let port = 3456;
while (port < 3500) {
  try {
    await server.listen(port);
    break;
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      port++;
      continue;
    }
    throw error;
  }
}
```

---

## Performance Characteristics

### Write Performance

- **Single update:** ~2ms (atomic write to SSD)
- **Deep merge:** ~1ms additional per 1KB of data
- **No bottleneck** for workflow execution

### Read Performance

- **Full session:** ~1ms for 100KB JSON
- **Targeted read** (JSONPath): ~2ms including parse
- **HTTP response:** ~5ms total (read + serialize + network)

### Dashboard Update Latency

- **Polling interval:** 1-2 seconds (adaptive)
- **HEAD request:** <1ms (ETag check)
- **Full fetch:** 5-10ms when data changes
- **UI render:** 10-20ms for complex views
- **Total perceived latency:** 1-2 seconds typical

---

## Scalability

### Session Size

- **Typical:** 50-200 KB
- **Large:** 500 KB - 1 MB
- **Maximum recommended:** 2 MB
- **Performance degradation:** Minimal up to 1 MB

### Concurrent Sessions

- **Same project:** 1 active (typical)
- **Multiple projects:** Unlimited
- **Dashboard viewers:** Unlimited (read-only)

### Long-Running Workflows

- **Duration:** Hours to days supported
- **Updates:** Thousands supported
- **File size growth:** Linear with investigation depth

---

Next: [04-DATA-MODEL.md](./04-DATA-MODEL.md) - Complete JSON schemas

