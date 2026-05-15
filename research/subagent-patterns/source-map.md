# Source Map -- Sub-agent Spawning Patterns Research

Mode: deep | Max entries: 8

## Sources

### S1: LangGraph Subgraph Documentation
- URL: https://docs.langchain.com/oss/python/langgraph/use-subgraphs
- Relevance: LangGraph is the most production-deployed framework with explicit subgraph primitives (call-as-node vs call-as-function). Has shipped typed state passing between parent and child graphs with two distinct patterns. Primary source for typed result contracts.

### S2: OpenAI Agents SDK Documentation (Agents, Handoffs, Running Agents)
- URL: https://openai.github.io/openai-agents-python/agents/
- Relevance: Production SDK (successor to Swarm). Has `as_tool` pattern for embedding a child agent as a tool in a parent, and `handoff` for transfer of control. Explicitly lists Dapr/Temporal/Restate/DBOS as durable execution integration points. Directly answers "how does a stateless SDK bolt onto a durable engine?"

### S3: Anthropic -- Building Effective Agents (Engineering Blog)
- URL: https://www.anthropic.com/engineering/building-effective-agents
- Relevance: Normative source from the primary model vendor. Describes orchestrator-workers pattern (central LLM breaks down task, delegates to workers, synthesizes results) as the pattern most applicable to MR review spawn-and-wait. Published Dec 2024 -- post-shipping, not speculative.

### S4: AutoGen AgentChat Teams Documentation
- URL: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- Relevance: Production framework at Microsoft. Has RoundRobin, Selector, Swarm, and Magentic-One patterns. Useful as contrarian case -- AutoGen's approach to structured multi-agent is flatly different (shared context, turn-taking) from parent-child spawning. Helps define what NOT to build.

### S5: OpenAI Swarm README (deprecated, superseded by Agents SDK)
- URL: https://github.com/openai/swarm/blob/main/README.md
- Relevance: Handoff-only architecture (transfer of control, not result return). Deliberately no result injection. Contrarian evidence that handoffs don't solve the "parent resumes with typed result" requirement. Its deprecation in favor of Agents SDK with `as_tool` is itself evidence of where the pattern evolved.

### S6: LangGraph Multi-Agent / Supervisor Patterns (Concepts)
- URL: https://langchain-ai.github.io/langgraph/concepts/multi_agent/
- Relevance: LangGraph's concept doc for supervisor-worker topology where parent acts as orchestrator. Documents how the parent waits for subgraph completion synchronously inside a node function -- the "call inside a node" pattern directly maps to WorkRail's step execution model.

### S7: Anthropic Claude Agent SDK Examples (agents_comprehensive.py)
- URL: https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/examples/agents_comprehensive.py
- Relevance: Shipped API usage showing how sessions, environments, and custom tool results are wired. The `user.custom_tool_result` event pattern reveals how typed results are injected back into a running agent session -- directly applicable to WorkRail's engine design problem.

### S8: CrewAI Hierarchical Process Documentation
- URL: https://docs.crewai.com/how-to/hierarchical-process
- Relevance: Critic/contrarian source. CrewAI's hierarchical mode uses a "manager LLM" that decides task delegation at runtime -- it is not statically typed result passing. Useful to show that LLM-directed delegation (no typed contracts) is one architectural choice, and why WorkRail should prefer the typed-artifact approach.
