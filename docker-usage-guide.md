# WorkRail MCP Docker Usage Guide

## Building the Docker Image

```bash
# Build the Docker image
docker build -f Dockerfile.simple -t workrail-mcp .
```

## Using with MCP Clients

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "workrail-mcp"
      ]
    }
  }
}
```

### VS Code MCP Extension

Add this to your `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "workrail": {
        "command": "docker",
        "args": [
          "run",
          "--rm",
          "-i",
          "workrail-mcp"
        ]
      }
    }
  }
}
```

### Other MCP Clients

Use the command pattern:
```bash
docker run --rm -i workrail-mcp
```

## Testing the Docker Image

Test MCP functionality manually:

```bash
# Test tools list
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | docker run --rm -i workrail-mcp

# Test workflow list
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workflow_list","arguments":{}}}' | docker run --rm -i workrail-mcp

# Test getting a specific workflow
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workflow_get","arguments":{"id":"coding-task-workflow-with-loops","mode":"metadata"}}}' | docker run --rm -i workrail-mcp
```

## Custom Workflows

To use custom workflows with Docker, mount a volume:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v", "/path/to/your/workflows:/app/custom-workflows",
        "-e", "WORKFLOW_STORAGE_PATH=/app/custom-workflows",
        "workrail-mcp"
      ]
    }
  }
}
```

## Requirements

- Docker installed and running
- MCP-compatible client (Claude Desktop, VS Code, etc.)
- Node.js 20+ (for building from source)

## Notes

- The Docker image uses Node.js 20 Alpine for security and small size
- Runs as non-root user for security
- Includes all built-in workflows
- Communicates via stdin/stdout (standard MCP protocol)
- No network ports exposed (MCPs don't need them)