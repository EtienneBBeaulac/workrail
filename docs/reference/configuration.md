# Configuration Reference

> ⚙️ **Detailed configuration options and examples**

[![Status](https://img.shields.io/badge/status-configuration_reference-green.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)

## 📋 Table of Contents

1. [Environment Variables](#environment-variables)
2. [Configuration Files](#configuration-files)
3. [Secrets & Sensitive Data](#secrets--sensitive-data)
4. [Example .env File](#example-env-file)
5. [Best Practices](#best-practices)

---

## Environment Variables

| Variable           | Description                                 | Example Value                        |
|--------------------|---------------------------------------------|--------------------------------------|
| NODE_ENV           | Node.js environment                         | production, development, test        |
| MCP_API_KEY        | API key for MCP server                      | supersecretkey                       |
| DATABASE_URL       | Database connection string                  | postgres://user:pass@host:5432/db    |
| REDIS_URL          | Redis connection string                     | redis://localhost:6379               |
| PORT               | Port for MCP server                         | 8080                                 |
| LOG_LEVEL          | Logging verbosity                           | info, debug, warn, error             |
| WORKFLOWS_PATH     | Path to workflow definitions                 | ./workflows                          |
| VALIDATION_TIMEOUT | Timeout for workflow validation (ms)        | 30000                                |
| SESSION_SECRET     | Secret for session management                | randomstring                         |
| JWT_SECRET         | Secret for JWT authentication               | randomstring                         |
| RATE_LIMIT_WINDOW  | Rate limit window in ms                     | 60000                                |
| RATE_LIMIT_MAX     | Max requests per window                     | 100                                  |
| CACHE_TTL          | Cache time-to-live in ms                    | 300000                               |
| BACKUP_PATH        | Path for storing backups                     | ./backups                            |
| ...                | ...                                         | ...                                  |

---

## Configuration Files

- `.env`: Main environment file for local development
- `config/default.json`: Default config (if using config package)
- `config/production.json`: Production overrides
- `docker-compose.yml`: Service-level config for containers

---

## Secrets & Sensitive Data

- Store secrets in environment variables or secret managers
- Never commit secrets to source control
- Rotate secrets regularly

---

## Example .env File

```
NODE_ENV=production
MCP_API_KEY=supersecretkey
DATABASE_URL=postgres://mcp:mcp_pass@postgres:5432/mcp_db
REDIS_URL=redis://redis:6379
PORT=8080
LOG_LEVEL=info
WORKFLOWS_PATH=./workflows
VALIDATION_TIMEOUT=30000
SESSION_SECRET=changeme
JWT_SECRET=changeme
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
CACHE_TTL=300000
BACKUP_PATH=./backups
```

---

## Best Practices

- Use `.env.example` to document required variables
- Validate config at startup and fail fast on missing/invalid values
- Use secret managers for production secrets
- Document all config changes in this file

---

**Need help with configuration?** Check the [Troubleshooting Guide](troubleshooting.md) or create an issue on GitHub. 