# WorkRail Console

A browser-based dashboard for inspecting WorkRail sessions.

## Status

Early stage. The basic substrate is implemented but the console is not yet a primary user surface.

## What exists

- **Session list view** -- lists all sessions with status, workflow ID, and timestamps
- **Session detail view** -- shows the DAG of nodes for a session with step-by-step detail
- **Node detail panel** -- displays per-node metadata, prompt content, and output
- **DAG visualization** -- renders the execution graph using `@xyflow/react` with custom layout
- **Health badge** -- shows session health status
- **Markdown rendering** -- renders agent notes as markdown

## Tech stack

- React 19, TypeScript, Vite
- Tailwind CSS v4
- `@tanstack/react-query` for data fetching
- `@tanstack/react-router` for routing
- `@xyflow/react` for DAG visualization
- `react-markdown` for rendering agent notes

## API

The console fetches from a local HTTP API:
- `GET /api/v2/sessions` -- list sessions
- `GET /api/v2/sessions/:id` -- session detail with DAG
- `GET /api/v2/sessions/:id/nodes/:nodeId` -- node detail

## Development

```bash
cd console
npm install
npm run dev
```

## What is not yet implemented

- Dashboard artifacts (structured outputs rendered per-workflow contract)
- Session state change notifications (auto-refresh)
- Any form of user interaction (the console is read-only)
- Authentication or multi-user support
