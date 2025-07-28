# Native Context Management: API Design

**Related Document:** [Native Context Management Design Doc](./native-context-management-design.md)

This document provides the detailed API specification for the native context management feature. It defines the contract for the new MCP tools, the server-side service interfaces, and the core data models.

## 1. MCP Tools API

This section defines the public-facing tools that will be exposed to LLM agents.

---

### `workflow_checkpoint_save`

Saves the current workflow state and context as a new checkpoint.

-   **Description:** "Saves the current workflow state and context to persistent storage. Returns a unique checkpoint ID for future resumption. This operation is atomic and will be skipped if the context is identical to the most recent checkpoint."
-   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "A unique identifier for the current workflow session. If not provided, a new session will be created."
        },
        "context": {
          "type": "object",
          "description": "The current workflow context object to be saved."
        },
        "metadata": {
          "type": "object",
          "description": "Optional user-defined metadata to attach to the checkpoint, such as a descriptive name or tags for searching.",
          "properties": {
              "name": { "type": "string" },
              "tags": { "type": "array", "items": { "type": "string" } }
          }
        },
        "force": {
          "type": "boolean",
          "description": "If true, saves the checkpoint even if the context has not changed since the last save. Defaults to false.",
          "default": false
        }
      },
      "required": ["sessionId", "context"]
    }
    ```
-   **Output Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "checkpointId": {
          "type": "string",
          "description": "The unique identifier for the newly created checkpoint."
        },
        "sessionId": {
          "type": "string",
          "description": "The session ID associated with this checkpoint."
        },
        "status": {
          "type": "string",
          "enum": ["SAVED", "SKIPPED_UNCHANGED"],
          "description": "Indicates whether a new checkpoint was saved or skipped because the context was identical to the previous one."
        },
        "sizeBytes": {
          "type": "number",
          "description": "The size of the compressed context in bytes."
        }
      },
      "required": ["checkpointId", "sessionId", "status"]
    }
    ```

---

### `workflow_checkpoint_load`

Loads a workflow's state and context from a specific checkpoint.

-   **Description:** "Loads a workflow's state and context from persistent storage. This will replace the active context for the current session. You can load by a specific checkpoint ID or get the latest from a session."
-   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "checkpointId": {
          "type": "string",
          "description": "The specific checkpoint ID to load. Mutually exclusive with `sessionId`."
        },
        "sessionId": {
          "type": "string",
          "description": "The session ID from which to load the latest checkpoint. Used if `checkpointId` is not provided."
        }
      },
      "oneOf": [
          { "required": ["checkpointId"] },
          { "required": ["sessionId"] }
      ]
    }
    ```
-   **Output Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "checkpointId": {
          "type": "string",
          "description": "The ID of the checkpoint that was loaded."
        },
        "sessionId": {
          "type": "string",
          "description": "The session ID of the loaded checkpoint."
        },
        "context": {
          "type": "object",
          "description": "The restored workflow context."
        },
         "metadata": {
          "type": "object",
          "description": "The metadata associated with the loaded checkpoint."
        }
      },
      "required": ["checkpointId", "sessionId", "context", "metadata"]
    }
    ```

---

### `workflow_checkpoint_list`

Lists available checkpoints, typically for a specific session.

-   **Description:** "Lists metadata for available checkpoints, ordered from most recent to oldest. Useful for finding a checkpoint to resume from."
-   **Input Schema:**
    ```json
    {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "The session ID to retrieve checkpoints for."
        },
        "limit": {
          "type": "number",
          "description": "The maximum number of checkpoints to return. Defaults to 20.",
          "default": 20
        },
        "offset": {
          "type": "number",
          "description": "The number of checkpoints to skip, for pagination. Defaults to 0.",
          "default": 0
        }
      },
      "required": ["sessionId"]
    }
    ```
-   **Output Schema:**
    ```json
    {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "checkpointId": { "type": "string" },
          "sessionId": { "type": "string" },
          "createdAt": { "type": "string", "format": "date-time" },
          "sizeBytes": { "type": "number" },
          "metadata": { "type": "object" }
        },
        "required": ["checkpointId", "sessionId", "createdAt", "metadata"]
      }
    }
    ```

---

### `workflow_mark_critical`

Marks a specific key within the context as `CRITICAL`.

- **Description:** "Provides an agent override to mark a specific key-value pair in the context as CRITICAL. This prevents it from being compressed or dropped under any circumstances. Use this for essential information like user goals or final answers."
- **Input Schema:**
    ```json
    {
        "type": "object",
        "properties": {
            "contextKey": {
                "type": "string",
                "description": "The top-level key in the context object to mark as critical."
            }
        },
        "required": ["contextKey"]
    }
    ```
- **Output Schema:**
    ```json
    {
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["SUCCESS", "KEY_NOT_FOUND"] },
            "message": { "type": "string" }
        },
        "required": ["status"]
    }
    ```

## 2. Server-Side Service Interface

A new service will be created to encapsulate the context management logic.

```typescript
// Location: src/application/services/context-management-service.ts

export interface IContextManagementService {
  /**
   * Saves a checkpoint.
   * Handles classification, compression, and writing to storage.
   */
  saveCheckpoint(params: {
    sessionId: string;
    context: object;
    metadata?: Partial<CheckpointMetadata>;
    force?: boolean;
  }): Promise<SaveResult>;

  /**
   * Loads a checkpoint.
   * Handles reading from storage and decompression.
   */
  loadCheckpoint(params: {
    checkpointId?: string;
    sessionId?: string;
  }): Promise<LoadResult>;

  /**
   * Lists checkpoints for a session.
   */
  listCheckpoints(params: {
    sessionId: string;
    limit?: number;
    offset?: number;
  }): Promise<CheckpointMetadata[]>;

  /**
   * Marks a context key as critical for the current session's persistence rules.
   */
  markCritical(params: {
      sessionId: string;
      contextKey: string;
  }): Promise<{status: 'SUCCESS' | 'KEY_NOT_FOUND', message: string}>;
}
```

## 3. Core Data Models

These are the primary data structures that will be stored in the SQLite database and filesystem.

```typescript
// Location: src/types/context-types.ts (new file)

/**
 * Represents the metadata for a single saved checkpoint.
 * This is the data that will be stored in the SQLite database.
 */
export interface CheckpointMetadata {
  id: string; // Primary Key, UUID
  sessionId: string; // Foreign Key to Session
  name?: string; // User-provided name for the checkpoint
  agentId?: string;
  createdAt: string; // ISO 8601 timestamp
  tags?: string[];
  contextSizeBytes: number; // Size of the compressed blob on disk
  contextHash: string; // SHA-256 of the uncompressed context to detect changes
  blobPath: string; // Relative path to the context blob file
}

/**
 * Represents a workflow session, which is a collection of checkpoints.
 */
export interface Session {
  id: string; // Primary Key, UUID
  createdAt: string; // ISO 8601 timestamp
  lastAccessedAt: string; // ISO 8601 timestamp
  // User-defined tags for the entire session
  tags?: string[];
  // Total storage used by this session's blobs
  totalSizeBytes: number;
}
```

## 4. Error Handling

The API will return standard MCP errors, but with specific error codes in the `data` payload for programmatic handling.

| Error Code                  | HTTP Status | Description                                       |
| --------------------------- | ----------- | ------------------------------------------------- |
| `CHECKPOINT_NOT_FOUND`      | 404         | The requested `checkpointId` does not exist.      |
| `SESSION_NOT_FOUND`         | 404         | The requested `sessionId` does not exist.         |
| `STORAGE_QUOTA_EXCEEDED`    | 413         | Cannot save checkpoint, storage limit reached.    |
| `STORAGE_UNAVAILABLE`       | 503         | The persistence layer is down (e.g., disk full).  |
| `INVALID_INPUT`             | 400         | The input parameters failed validation.           |
| `CONTEXT_UNCHANGED`         | 200         | (Not an error) Returned when `force:false` and context is identical. | 