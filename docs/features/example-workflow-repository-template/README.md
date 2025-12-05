# Example Workflow Repository Template

This is a template for creating your own workflow repository that can be used with WorkRail's external workflow feature.

## Quick Start

### 1. Use This Template

```bash
# Option A: Via GitHub UI
1. Click "Use this template" button
2. Create your repository
3. Clone it locally

# Option B: Manual
git clone https://github.com/your-org/your-workflows.git
cd your-workflows
```

### 2. Add Your Workflows

```bash
# Add a workflow file
cat > workflows/my-workflow.json << 'EOF'
{
  "id": "my-workflow",
  "name": "My Custom Workflow",
  "description": "Description of what this workflow does",
  "version": "1.0.0",
  "steps": [
    {
      "id": "step-1",
      "title": "First Step",
      "prompt": "Instructions for this step"
    }
  ]
}
EOF

# Validate it
workrail validate workflows/my-workflow.json

# Commit and push
git add workflows/my-workflow.json
git commit -m "Add my-workflow"
git push
```

### 3. Use the Repository

```bash
# Configure WorkRail to use this repository
export WORKFLOW_GIT_REPO_URL=https://github.com/your-org/your-workflows.git

# Initialize (clones the repository)
workrail init

# List workflows (includes your custom workflows)
workrail list

# Run a workflow
workrail run my-workflow
```

## Repository Structure

```
your-workflows/
├── README.md                    # This file
├── workflows/                   # Required: All workflows go here
│   ├── example-workflow.json    # Example workflow (can be deleted)
│   └── ...                      # Your workflow files
├── .gitignore                   # Git ignore file
├── .github/
│   └── workflows/
│       └── validate.yml         # CI/CD validation
└── CONTRIBUTING.md              # Contribution guidelines (optional)
```

## Workflow File Format

Each workflow must be a valid JSON file following the WorkRail schema:

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
      "prompt": "Instructions for this step",
      "guidance": ["Optional guidance"],
      "requireConfirmation": false
    }
  ]
}
```

## Naming Conventions

- **Workflow IDs**: Use lowercase with hyphens (e.g., `code-review`, `bug-fix`)
- **File names**: Should match workflow ID (e.g., `code-review.json`)
- **Versions**: Use semantic versioning (e.g., `1.0.0`, `1.2.3`)

## Validation

Before committing workflows, validate them:

```bash
# Validate a single workflow
workrail validate workflows/my-workflow.json

# Validate all workflows
for file in workflows/*.json; do
  workrail validate "$file"
done
```

## CI/CD Integration

The included `.github/workflows/validate.yml` automatically validates all workflows on:
- Push to main
- Pull requests

This ensures only valid workflows are merged.

## Contributing

### Adding a New Workflow

1. Fork this repository
2. Create a new branch: `git checkout -b add-my-workflow`
3. Add your workflow to `workflows/`
4. Validate it: `workrail validate workflows/my-workflow.json`
5. Commit: `git commit -m "Add my-workflow"`
6. Push: `git push origin add-my-workflow`
7. Create a pull request

### Modifying an Existing Workflow

1. Follow the same process as adding a new workflow
2. Increment the version number in the workflow
3. Document changes in the PR description

### Code Review Checklist

- [ ] Workflow ID is unique
- [ ] File name matches workflow ID
- [ ] JSON is valid
- [ ] Schema validation passes
- [ ] Version number is updated (for modifications)
- [ ] Description is clear and helpful
- [ ] Steps are well-documented

## Usage Patterns

### Team Repository (Private)

For private team workflows with authentication:

```bash
export WORKFLOW_GIT_REPO_URL=https://github.com/myteam/workflows.git
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
workrail init
```

### Multi-Repository Setup

Combine multiple repositories (e.g., community + team):

```bash
export WORKFLOW_GIT_REPOS='[
  {
    "repositoryUrl": "https://github.com/workrail/community-workflows.git",
    "branch": "main",
    "syncInterval": 1440
  },
  {
    "repositoryUrl": "https://github.com/myteam/workflows.git",
    "branch": "main",
    "syncInterval": 60,
    "authToken": "'${GITHUB_TOKEN}'"
  }
]'
```

## Best Practices

### Workflow Organization

- One workflow per file
- Clear, descriptive names
- Comprehensive descriptions
- Well-structured steps
- Version your workflows

### Security

- Review all workflow changes
- Use branch protection
- Require pull request reviews
- Don't include sensitive data in workflows
- Use private repositories for sensitive workflows

### Performance

- Keep workflows under 1MB
- Limit to 100 workflows per repository
- Use appropriate sync intervals (60+ minutes)

### Documentation

- Document workflow purpose in description
- Include examples in workflow guidance
- Maintain this README with usage instructions
- Document any special requirements

## Troubleshooting

### Workflow Not Loading

```bash
# Check if repository is cloned
ls -la ~/.workrail/

# Force re-sync
rm -rf ~/.workrail/your-repo-name
workrail init
```

### Validation Failures

```bash
# Common issues:
- Missing required fields (id, name, description, version, steps)
- Invalid JSON syntax
- Workflow ID doesn't match filename
- Invalid step structure
```

### Authentication Issues

```bash
# Verify token has access
curl -H "Authorization: token ${GITHUB_TOKEN}" \
  https://api.github.com/repos/your-org/your-workflows

# Test clone manually
git clone https://github.com/your-org/your-workflows.git /tmp/test
```

## Support

- **Issues**: [Create an issue](https://github.com/your-org/your-workflows/issues)
- **Discussions**: [Join the discussion](https://github.com/your-org/your-workflows/discussions)
- **WorkRail Docs**: [Read the documentation](https://workrail.io/docs)

## License

[Your License Here]

## Credits

Created with the WorkRail workflow repository template.

