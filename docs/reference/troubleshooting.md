# Troubleshooting Guide

>  **Common issues and solutions**

[![Status](https://img.shields.io/badge/status-troubleshooting_guide-green.svg)](https://github.com/EtienneBBeaulac/mcp)
[![Spec Version](https://img.shields.io/badge/spec-1.0.0-blue.svg)](specs/)

##  Table of Contents

1. [Startup Issues](#startup-issues)
2. [Configuration Problems](#configuration-problems)
3. [Workflow Errors](#workflow-errors)
4. [API & Connectivity](#api--connectivity)
5. [Performance Issues](#performance-issues)
6. [Security & Access](#security--access)
7. [Backup & Recovery](#backup--recovery)
8. [Getting Help](#getting-help)

---

## Startup Issues

- **App won’t start**: Check logs for errors, verify Node.js version, and required environment variables.
- **Port in use**: Change `PORT` variable or stop conflicting service.
- **Dependency errors**: Run `npm install` and check for missing packages.

---

## Configuration Problems

- **Missing env vars**: Compare with `.env.example` and fill in all required values.
- **Invalid config**: Check for typos, invalid URLs, or unsupported values.
- **Secrets not loading**: Ensure secret manager integration is correct and permissions are set.

---

## Workflow Errors

- **Workflow not found**: Confirm workflow file exists and `WORKFLOWS_PATH` is correct.
- **Validation failed**: Check workflow JSON against schema and fix errors.
- **Step execution fails**: Review step prompts, required fields, and agent logs.

### Workflow JSON Validation Issues

- **"JSON syntax error"**: Check for missing quotes, commas, or braces in workflow JSON.
- **"Missing required property"**: Ensure all required fields (id, name, description, steps) are present.
- **"Invalid workflow structure"**: Verify workflow follows the schema specification.
- **"Validation timeout"**: Large workflows may need increased timeout settings.

**Common JSON Syntax Issues:**
- Missing closing braces `}` or brackets `]`
- Unescaped quotes in string values
- Trailing commas in arrays or objects
- Invalid escape sequences

**Schema Validation Errors:**
- Missing required `id`, `name`, `description`, or `steps` fields
- Invalid `id` pattern (must be alphanumeric with hyphens/underscores)
- Empty `steps` array (must contain at least one step)
- Invalid step structure (missing `id`, `title`, or `prompt`)

---

## API & Connectivity

- **API returns 500**: Check server logs for stack traces and error details.
- **Timeouts**: Increase client timeout or check server load.
- **CORS errors**: Update allowed origins in CORS config.

---

## Performance Issues

- **Slow responses**: Check for high CPU/memory, database slow queries, or cache misses.
- **High memory usage**: Profile with Node.js tools, check for memory leaks.
- **Scaling problems**: Review auto-scaling and worker thread settings.

---

## Security & Access

- **Unauthorized errors**: Verify API keys, JWT tokens, and user permissions.
- **Rate limited**: Reduce request frequency or increase rate limit settings.
- **Sensitive data in logs**: Update logging config to redact secrets.

---

## Backup & Recovery

- **Backup failed**: Check backup script logs, storage permissions, and available disk space.
- **Restore failed**: Verify backup file integrity and correct restore commands.
- **Disaster recovery**: Follow the [Recovery Reference](recovery.md) and runbook.

---

## Getting Help

- **Check documentation**: Review all guides in the `docs/` directory.
- **Search issues**: Look for similar problems on GitHub.
- **Ask for help**: Open a new issue with detailed logs and steps to reproduce.
- **Contact maintainers**: See project README for contact info.

---

**Still stuck?** Open an issue on GitHub or ask in the project discussion board for support. 