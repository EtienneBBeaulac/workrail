# Workflow Management

WorkRail supports loading workflows from multiple directories, making it easy to use both bundled workflows and your own custom workflows simultaneously.

## Directory Priority

WorkRail loads workflows from multiple sources in the following priority order (later sources override earlier ones with the same ID):

1. **Bundled Workflows** - Pre-built workflows included with WorkRail
2. **User Workflows** - Your personal workflow collection (`~/.workrail/workflows`)
3. **Project Workflows** - Project-specific workflows (`./workflows`)
4. **Custom Directories** - Additional directories via environment variables

## Getting Started

### 1. Initialize User Workflow Directory

Create your personal workflow directory with a sample workflow:

```bash
workrail init
```

This creates:
- `~/.workrail/workflows/` directory
- A sample workflow file to get you started
- Proper directory permissions

### 2. List Available Workflows

See all workflows from all sources:

```bash
# Basic listing
workrail list

# Detailed listing with version info
workrail list --verbose
```

### 3. Check Workflow Sources

View all workflow directory sources and their status:

```bash
workrail sources
```

This shows:
- Which directories are being scanned
- Whether each directory exists
- How many workflow files are in each directory

## Adding Custom Workflows

### Method 1: User Directory (Recommended)

1. Initialize your user directory:
   ```bash
   workrail init
   ```

2. Create workflow files in `~/.workrail/workflows/`:
   ```bash
   cd ~/.workrail/workflows
   # Create your custom workflow
   cat > my-workflow.json << 'EOF'
   {
     "id": "my-custom-workflow",
     "name": "My Custom Workflow",
     "description": "A custom workflow for my specific needs",
     "version": "1.0.0",
     "steps": [
       {
         "id": "step-1",
         "name": "First Step",
         "description": "Custom step description",
         "guidance": "What to do in this step"
       }
     ]
   }
   EOF
   ```

### Method 2: Project Directory

Create a `workflows/` directory in your project:

```bash
mkdir workflows
cd workflows
# Add your project-specific workflows here
```

### Method 3: Environment Variables

Set custom directories using environment variables:

```bash
# Single custom directory
export WORKFLOW_STORAGE_PATH="/path/to/my/workflows"

# Multiple custom directories (colon-separated)
export WORKFLOW_STORAGE_PATH="/path/to/workflows1:/path/to/workflows2"

# Use with workrail
workrail list
```

### Method 4: Temporary Override

Use environment variables for one-time usage:

```bash
WORKFLOW_STORAGE_PATH="/tmp/my-workflows" workrail list
```

## Workflow File Format

Workflows must be valid JSON files that conform to the workflow schema:

```json
{
  "id": "unique-workflow-id",
  "name": "Human Readable Name",
  "description": "What this workflow does",
  "version": "1.0.0",
  "steps": [
    {
      "id": "step-1",
      "title": "Step Name",
      "prompt": "User-facing instructions for this step",
      "agentRole": "Optional: AI agent behavioral guidance (e.g., 'You are a security expert...')",
      "guidance": ["Optional guidance items"],
      "askForFiles": true,
      "requireConfirmation": false,
      "runCondition": {
        "var": "some_variable",
        "equals": "expected_value"
      }
    }
  ]
}
```

### Step Field Reference

- **`id`**: Unique step identifier (required)
- **`title`**: Human-readable step name (required)
- **`prompt`**: User-facing instructions (required)
- **`agentRole`**: AI agent behavioral guidance (optional, 10-1024 characters)
- **`guidance`**: Array of guidance strings (optional)
- **`askForFiles`**: Whether to request file context (optional, default: false)
- **`requireConfirmation`**: Whether to pause for user confirmation (optional, default: false)
- **`runCondition`**: Conditional execution logic (optional)

## Validation

Validate your workflow files before using them:

```bash
# Validate a specific file
workrail validate my-workflow.json

# Validate all files in a directory
find ~/.workrail/workflows -name "*.json" -exec workrail validate {} \;
```

## Loop Optimization (v0.2.0+)

WorkRail automatically optimizes loop execution to reduce context size:

### Progressive Context Disclosure

- **First iteration**: Full loop overview + first step details
- **Subsequent iterations**: Minimal context with current item only
- **Context reduction**: 60-80% smaller responses after first iteration

### Function DSL

Define reusable functions to reduce duplication:

```json
{
  "functionDefinitions": [
    {
      "name": "processItem",
      "definition": "Validates and transforms item data"
    }
  ],
  "steps": [{
    "prompt": "Use processItem() to handle the current item",
    "functionReferences": ["processItem()"]
  }]
}
```

### Empty Loop Detection

Loops with no items are automatically skipped, improving performance.

For detailed information, see [Loop Optimization Guide](features/loop-optimization.md).

## Advanced Configuration

### Disable Specific Sources

You can disable specific workflow sources using environment variables:

```bash
# Disable bundled workflows
export WORKFLOW_INCLUDE_BUNDLED=false

# Disable user workflows
export WORKFLOW_INCLUDE_USER=false

# Disable project workflows
export WORKFLOW_INCLUDE_PROJECT=false
```

### Custom File Storage Options

Configure workflow storage behavior:

```bash
# Cache workflows for 30 seconds (default: 60 seconds)
export WORKFLOW_CACHE_TTL=30000

# Maximum workflow file size (default: 1MB)
export WORKFLOW_MAX_FILE_SIZE=2000000
```

## Workflow Precedence

When multiple workflows have the same ID, the one from the highest priority source wins:

1. **Custom Directories** (highest priority)
2. **Project Workflows**
3. **User Workflows**
4. **Bundled Workflows** (lowest priority)

This means you can override any bundled workflow by creating a custom one with the same ID.

## Best Practices

### Organization

- **User Directory**: Personal workflows you use across projects
- **Project Directory**: Project-specific workflows
- **Custom Directories**: Shared team workflows or specialized collections

### Naming

- Use descriptive, unique IDs: `team-code-review`, `deploy-frontend`
- Include version numbers for major changes
- Use consistent naming conventions within your team

### Version Control

- **Do include**: Project workflows in version control
- **Don't include**: Personal user workflows in project repos
- **Consider**: Separate repos for shared workflow collections

### Testing

- Always validate workflows before using them
- Test workflows in a development environment first
- Use the `workrail sources` command to debug loading issues

### Advanced Patterns

- **Function References**: For complex workflows with repeated instructions, use the function reference pattern to reduce duplication and improve maintainability (see [Function Reference Pattern guide](implementation/09-simple-workflow-guide.md#function-reference-pattern-advanced))
- **Conditional Logic**: Use `runCondition` for adaptive workflows that branch based on context
- **Loop Patterns**: Leverage loop steps for iterative tasks like multi-step implementation

## Troubleshooting

### Workflow Not Found

```bash
# Check if your workflow directory exists
workrail sources

# Verify workflow file syntax
workrail validate your-workflow.json

# List all available workflows
workrail list
```

### Permission Issues

```bash
# Fix directory permissions
chmod 755 ~/.workrail/workflows

# Fix file permissions
chmod 644 ~/.workrail/workflows/*.json
```

### Schema Validation Errors

Common issues:

1. **Missing required fields**: Ensure `id`, `name`, `description`, `version`, and `steps` are present
2. **Invalid JSON**: Use a JSON validator to check syntax
3. **Invalid step structure**: Each step needs `id`, `name`, `description`, and `guidance`

## Integration with AI Assistants

Once your workflows are set up, they're automatically available to any MCP-enabled AI assistant:

1. **Claude Desktop**: Add WorkRail to your MCP configuration
2. **VS Code**: Configure WorkRail as an MCP server
3. **Custom Applications**: Connect to WorkRail's MCP interface

The AI assistant will automatically have access to all your workflows from all configured sources. 