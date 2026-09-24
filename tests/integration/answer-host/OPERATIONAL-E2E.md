# Answer workflow operational proof

Run `npm run build`, then `npm run test:answer-e2e`.
CI runs the test with retries disabled on Linux, macOS and Windows, on Node 20 and 22.

The deterministic MCP consumer launches the built WorkRail server, discovers its tools,
opens a two-step workflow, reads a real fixture file, and submits its content. It kills
the server after the acknowledged commit, launches a new server against the same storage,
and retries the original answer. The original receipt must return without a reply capability.
Recovery must expose the unchanged second task. A real child process produces a file,
and the consumer submits its output. The standalone console's HTTP endpoints must show
completion and both retained receipts without granting answer authority.

The test replaces model judgment with a fixed script. It uses no provider credentials,
live model, installed runtime, user workspace or WorkTrain daemon. It does not establish
Docker isolation, browser rendering, unknown-outcome recovery before acknowledgement,
or whether a real model can solve the task. Those are separate coverage boundaries.
The console runs through its public composition in the test process; the MCP server and
workspace command are separate processes.
