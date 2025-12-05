# Sequence Diagrams for Native Context Management

This document contains sequence diagrams illustrating the key operations of the context management feature.

## `workflow_checkpoint_save`

This diagram shows the end-to-end flow when an agent calls the `workflow_checkpoint_save` tool. It includes the logic for skipping unchanged context and the full path for saving a new checkpoint, including classification, compression, and atomic storage operations.

```mermaid
sequenceDiagram
    participant Agent
    participant MCP Server
    participant ContextMgmtService
    participant ClassificationService
    participant CompressionService
    participant SQLiteStorage
    participant BlobStorage

    Agent->>MCP Server: CallTool("workflow_checkpoint_save", {sessionId, context})
    MCP Server->>ContextMgmtService: saveCheckpoint({sessionId, context})
    
    Note over ContextMgmtService: Calculate hash of incoming context.
    ContextMgmtService->>SQLiteStorage: getLatestCheckpointHash(sessionId)
    SQLiteStorage->>ContextMgmtService: "previous_hash_abc"

    alt Context has NOT changed
        ContextMgmtService->>MCP Server: {status: "SKIPPED_UNCHANGED"}
        MCP Server->>Agent: Result({status: "SKIPPED_UNCHANGED"})
    else Context HAS changed
        ContextMgmtService->>ClassificationService: classify(context)
        ClassificationService->>ContextMgmtService: classifiedContext

        ContextMgmtService->>CompressionService: compress(classifiedContext)
        CompressionService->>ContextMgmtService: compressedBlob

        ContextMgmtService->>SQLiteStorage: beginTransaction()
        Note over ContextMgmtService: Pessimistic Lock on Session
        ContextMgmtService->>SQLiteStorage: acquireSessionLock(sessionId)
        SQLiteStorage->>ContextMgmtService: LockAcquired

        ContextMgmtService->>BlobStorage: saveTempBlob(compressedBlob)
        BlobStorage->>ContextMgmtService: {tempPath: "path/to/temp.gz"}
        
        Note over ContextMgmtService: Create metadata with hash, size, and tempPath
        ContextMgmtService->>SQLiteStorage: createCheckpointMetadata(metadata)
        SQLiteStorage->>ContextMgmtService: {checkpointId: "new_id_xyz"}

        ContextMgmtService->>SQLiteStorage: commitTransaction()
        
        ContextMgmtService->>BlobStorage: promoteTempBlob(tempPath, finalPath)
        BlobStorage->>ContextMgmtService: {finalPath: "path/to/final.gz"}
        
        ContextMgmtService->>MCP Server: {status: "SAVED", checkpointId: "new_id_xyz"}
        MCP Server->>Agent: Result({status: "SAVED", checkpointId: "new_id_xyz"})
    end
``` 