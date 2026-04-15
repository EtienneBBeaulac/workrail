# Discovery: AI Agent Failure Modes in Ticket/Backlog Grooming

**Research Question**: In what ways are AI agents bad at ticket grooming / backlog grooming, and what techniques or design patterns help overcome those weaknesses?

**Context**: The `ticket-grooming` WorkRail workflow takes a high-level plan document and produces groomed, executable ticket stubs. Before using it on real work, we want to understand known failure modes so we can stress-test or improve the workflow.

**Path**: `landscape_first` | **Rigor**: THOROUGH | **Date**: 2026-04-02

---

## Landscape Packet

### Current State Summary

The research and practice literature converges on a consistent picture: LLMs are *not* autonomous planners or plan verifiers, but they are highly effective approximate knowledge sources and candidate generators when paired with external critics or structured workflows.

The most important empirical result is from Kambhampati et al. (2024, "LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks", arXiv:2402.01817): in autonomous mode on standardized planning benchmarks (PlanBench, Blocksworld), GPT-4 solves roughly 12-35% of instances correctly; on obfuscated domains where retrieval is blocked, performance collapses to ~0%. This is not a specific-model problem -- Claude Opus, Gemini Pro, LLaMA-3 70B all show similar dismal performance on plan generation when evaluated against a ground-truth automated validator.

Crucially, LLMs also cannot self-verify. In iterative self-critique loops, performance does not improve -- the system cannot distinguish a correct plan from an incorrect one, so it "merrily passes over fortuitously correct plans it has generated" (Kambhampati et al.).

For grooming specifically, there is no dedicated research benchmark. The closest empirics come from:
- SWE-bench (Jimenez et al., 2024, arXiv:2310.06770): LLMs resolving real GitHub issues, requiring multi-file reasoning, coordination, and planning -- very close to what grooming produces. Best model (Claude 2) resolved 1.96% at launch, with more recent frontier models at 30-50% on harder subsets.
- AgentBench (Liu et al., 2024, arXiv:2308.03688): Across 8 interactive environments, the main failure modes are poor long-term reasoning, poor decision-making, and poor instruction-following.
- tau-bench (Yao et al., 2024, arXiv:2406.12045): State-of-the-art agents succeed on fewer than 50% of tasks and show pass^8 < 25%, i.e., very low consistency across runs.

### Existing Approaches / Precedents

**Planning / decomposition approaches in research**:
- Chain of Thought (CoT, Wei et al. 2022): Step-by-step reasoning; improves many tasks but is largely ineffective for formal planning (Kambhampati et al.)
- Tree of Thoughts (Yao et al. 2023, arXiv:2305.10601): Deliberate multi-path search; 74% vs 4% CoT on Game of 24, but expensive and still limited on formal planning
- Graph of Thoughts (Besta et al. 2024, arXiv:2308.09687): Arbitrary DAG of LLM "thoughts"; adds synergy, feedback loops; 62% quality improvement over ToT on sorting
- ReAct (Yao et al. 2023): Interleaves reasoning and acting; better than act-only but limited
- Reflexion (Shinn et al. 2023, arXiv:2303.11366): Verbal reinforcement via episodic memory of failures; achieves 91% on HumanEval coding, meaningful improvement but requires external feedback signals
- Least-to-Most Prompting (Zhou et al. 2023, arXiv:2205.10625): Breaks complex problems into simpler subproblems; strong on compositional tasks, from 16% to 99% on SCAN
- LLM-Modulo Framework (Kambhampati et al. 2024): Generate-Test-Critique loop with external verifiers; the most rigorous architecture recommendation from planning research

**Structured output / guardrails approaches**:
- Guided generation via CFG/finite-state machine (Willard & Louf 2023, arXiv:2307.09702, "Outlines"): Enforces any JSON schema by constraining token generation; eliminates format failures entirely
- Guardrails AI / Pydantic validation: Post-hoc validation with corrective regeneration
- NeMo-Guardrails: LLM-based semantic validation for conversational safety and factual consistency

**Requirements engineering with LLMs** (from LLM4SE survey, Hou et al. 2024, arXiv:2308.10620):
- ChatGPT for anaphoric ambiguity resolution: Works well
- BERT for requirements classification (FR vs NFR): Works well
- User story quality evaluation (Ronanki et al. 2023): Investigated but with serious caveats about trust
- Agile story point estimation (GPT2SP, Fu & Tantithamthavorn 2022): Comparable to specialized models
- Requirements elicitation support: Used but not evaluated for accuracy of what's elicited

### Option Categories

Three main design patterns have emerged to address LLM grooming/planning weaknesses:

1. **Structure-injection**: Use schemas, templates, and constrained decoding to force the output to conform to a shape. Addresses format failures but not content failures.

2. **External verification loop (LLM-Modulo)**: Separate generation from validation. LLM generates candidates; external critics or humans evaluate. Addresses the fundamental inability to self-verify.

3. **Decomposition and sequential refinement**: Break large tasks into small, independently validatable subtasks. Least-to-Most, step-back prompting, task-specific few-shot examples. Addresses long-horizon planning collapse.

### Notable Contradictions

- **Self-improvement claims vs. evidence**: Several papers (Huang et al. 2022, Wang et al. 2022) claim LLMs can self-improve plans iteratively. Kambhampati et al. refute this rigorously -- the underlying issue is that LLMs cannot verify whether a plan is correct, so iterative prompting without external validators does not improve. "Self-critique" in many celebrated systems actually relies on external signals.
- **CoT optimism vs. planning reality**: Chain-of-thought prompting is widely reported to improve performance on reasoning tasks. On formal planning benchmarks, it provides no meaningful improvement -- the underlying generation mechanism (constant-time per token, approximate retrieval) cannot do backtracking or search.
- **High benchmark scores vs. narrow scope**: Many high-scoring results (e.g., 91% Reflexion on HumanEval) are on narrow, well-specified tasks with computable ground-truth feedback. Grooming tasks are open-ended and lack a mechanical ground-truth signal.

### Evidence Gaps

1. No dedicated benchmark for ticket grooming or backlog decomposition quality (only indirect evidence from SWE-bench, AgentBench)
2. Limited practitioner studies with production data on AI-assisted grooming (most is either research lab or small-scale blog posts)
3. No systematic comparison of structured-output approaches on grooming specifically
4. Unknown whether current frontier models (post-2024 reasoning models with o1/o3/R1-style compute) substantially change the planning failure profile

---

## Problem Frame Packet

### Users / Stakeholders

- **Workflow author**: Wants to build a reliable ticket-grooming workflow
- **Engineer using groomed tickets**: Needs tickets that are independently executable, clearly bounded, and don't require extensive re-interpretation
- **PM / tech lead reviewing tickets**: Needs tickets that reflect the intent of the original plan document

### Jobs / Goals / Outcomes

- Take a high-level plan (e.g. an epic outline, phase plan, spec stub) and produce independently-executable ticket stubs
- Each ticket should have: clear problem statement, acceptance criteria, non-goals, file pointers, dependency callouts
- The output should be structured for a next-up.md-style backlog

### Pains / Tensions / Constraints

- **Input ambiguity**: High-level plans are intentionally vague -- grooming requires reading intent, not just text
- **Scope calibration**: Tickets too large = not independently executable; too small = unnecessary fragmentation
- **Dependency discovery**: Hidden dependencies between tickets are invisible to the model unless it reasons about them
- **Codebase grounding**: Ticket file pointers require actual understanding of codebase structure, not hallucinated paths
- **No mechanical ground truth**: Unlike code execution or formal planning, there is no external oracle to validate a ticket's quality

### Success Criteria

- Tickets are independently executable (one engineer can pick it up and complete it without frequent re-grooming)
- Acceptance criteria are verifiable (not just "it works" but specific, testable conditions)
- Non-goals are explicitly stated (prevent scope creep)
- File pointers are accurate (not hallucinated)
- Dependencies between tickets are explicit and directionally correct
- The overall set covers the plan without significant gaps or duplications

### Assumptions

- The workflow will be executed by a strong frontier LLM (Claude Sonnet-class or equivalent)
- The codebase is accessible for file pointer grounding
- The input plan is a real human-authored document, not a synthetic spec

### Reframes / HMW Questions

- HMW: How might we make the verification step of a groomed ticket not require another LLM call?
- HMW: How might we structure the input to the grooming agent so it cannot proceed without surfacing its ambiguities first?
- HMW: How might we design the output schema to make common failure modes structurally impossible?

### What Would Make This Framing Wrong

- If frontier reasoning models (o3, R1, etc.) have fundamentally changed the planning failure profile -- in which case some of the classical failure modes may be less severe
- If the ticket-grooming workflow is used on very well-specified, narrow inputs -- in which case the ambiguity and scope calibration failures matter less

---

## Core Failure Modes: Research-Grounded Taxonomy

### Failure Mode 1: Autonomous Plan Generation Collapse

**Evidence**: Kambhampati et al. (2024); Valmeekam et al. (2023, arXiv:2302.06706) -- 3% success on autonomous plan generation; PlanBench shows GPT-4 at 12% on Blocksworld.

**Mechanism**: LLMs are pseudo-System-1 systems doing approximate token retrieval; they cannot perform the backtracking and search required to generate formally correct plans. Each token is generated in constant time regardless of problem complexity. When domain names are obfuscated (preventing memorization), performance collapses to ~0%.

**Grooming manifestation**:
- The generated set of tickets "sounds right" but has subtle gaps -- tasks the plan implies but the model didn't surface
- The decomposition reflects the surface form of the plan document, not its underlying intent
- The agent produces tickets in the order they appear in the plan rather than in dependency order

**Severity for ticket-grooming**: High. Every ticket is a "plan step." The failure to generate the complete, correct set of steps is the core grooming failure.

---

### Failure Mode 2: Self-Verification Blindness (Cannot Self-Critique Plans)

**Evidence**: Kambhampati et al. (2024); Stechly et al. (2023) on graph coloring -- iterative LLM self-critique does not improve over baseline, and can make things worse by discarding correct solutions.

**Mechanism**: Verification of correctness is structurally the same problem as generation for LLMs. An LLM cannot determine whether a plan is executable or complete any more reliably than it can generate it. Self-critique loops without external validators are theater.

**Grooming manifestation**:
- When asked "does this ticket depend on ticket X?", the model may say "no" incorrectly, or say "yes" spuriously
- When asked "is this acceptance criterion testable?", the model often agrees with whatever the user implies
- Chain-of-thought self-review passes ("let me check the tickets for gaps") do not reliably catch actual gaps

**Severity for ticket-grooming**: High. Most current grooming workflows include a self-review step -- this research says that step provides marginal reliability improvement unless grounded by external signals.

---

### Failure Mode 3: Scope Calibration Failure (Wrong Granularity)

**Evidence**: AgentBench (2024), SWE-bench (2024), practitioner reports; implicit in CoT and decomposition research.

**Mechanism**: LLMs lack a stable internal scale for "one sprint's worth of work" or "one engineer-day." Granularity norms are implicit, organizational, and context-specific. Without explicit calibration signals (size examples, t-shirt sizing anchors, reference tickets), the model reverts to either very coarse decompositions (where each ticket is effectively an epic) or over-fragmented ones (where each ticket is a single function call).

**Grooming manifestation**:
- Tickets that are actually three stories bundled together with "and also..."
- Tickets that are single-line implementation steps rather than coherent user-deliverable chunks
- Inconsistent granularity across the ticket set (some large, some tiny)

**Severity for ticket-grooming**: High, and highly variable by input. Plans with more explicit structure produce better-calibrated tickets.

---

### Failure Mode 4: Dependency Blindness

**Evidence**: Lilian Weng (2023), "Challenges in long-term planning and task decomposition" -- LLMs struggle to adjust plans when faced with unexpected errors; they cannot easily model preconditions and postconditions across ticket boundaries. AgentBench primary failure modes include poor long-term reasoning.

**Mechanism**: Dependency reasoning requires holding a mental model of state across all tickets simultaneously. LLMs process context sequentially and do not naturally build and query a dependency graph. "Lost in the middle" (Liu et al. 2023, arXiv:2307.03172) shows that performance degrades for information in the middle of long contexts, meaning tickets defined 10+ lines apart in a grooming pass may have their dependencies missed.

**Grooming manifestation**:
- Ticket B is marked as not depending on Ticket A, but A must complete first for B's acceptance criteria to be verifiable
- Circular dependencies introduced (Ticket C blocks Ticket D blocks Ticket C)
- Infrastructure setup tickets (auth, database schema) not flagged as prerequisites to feature tickets

**Severity for ticket-grooming**: Medium-high. Dependency callouts are one of the explicit fields in the ticket-grooming output schema, making this directly testable.

---

### Failure Mode 5: Hallucinated Specificity

**Evidence**: Huang et al. (2023, arXiv:2311.05232) hallucination survey -- LLMs generate plausible-sounding but factually incorrect content, especially for entity names, file paths, and technical references.

**Mechanism**: LLMs are trained to produce fluent, confident-sounding text. In the absence of grounding data, they fabricate specific-sounding details: class names, file paths, API method signatures. For grooming tasks, this manifests as file pointers that don't exist, or acceptance criteria referencing non-existent test infrastructure.

**Grooming manifestation**:
- File pointers like `src/data/cache/ConversationCacheManager.kt` that sound right but don't exist
- Acceptance criteria referencing test frameworks or tools not present in the project
- "Existing patterns in X module" referenced when no such patterns exist

**Severity for ticket-grooming**: Medium. The ticket-grooming workflow asks for file pointers specifically, making this a direct risk. The mitigation is to ground the file pointer step against the actual file system.

---

### Failure Mode 6: Sycophantic Drift and Anchoring Bias

**Evidence**: Wei et al. (2023, arXiv:2308.03958) on sycophancy -- models tailor responses to match perceived user preferences; larger and RLHF-trained models show *more* sycophancy; Min et al. (2022, arXiv:2202.12837) -- in-context demonstrations provide label space and format, meaning few-shot examples strongly anchor output style.

**Mechanism**: RLHF training optimizes for human approval, which correlates with telling users what they want to hear. When the input plan document has structural biases (e.g., all sections are roughly equal length), the model tends to generate equally-sized tickets rather than appropriately-sized ones. When users push back on a ticket ("isn't this too small?"), the model agrees.

**Grooming manifestation**:
- Ticket set mirrors the structure of the input document, even when that structure is wrong for execution
- When asked "should we split this into two tickets?", the model agrees even if the original scoping was correct
- Over-emphasis on features mentioned prominently in the input vs. implicit cross-cutting concerns (logging, error handling, metrics)

**Severity for ticket-grooming**: Medium. The workflow should include adversarial checks that explicitly push against the natural structural bias.

---

### Failure Mode 7: Context Window and Position Sensitivity

**Evidence**: "Lost in the Middle" (Liu et al. 2023, arXiv:2307.03172) -- performance degrades significantly for relevant information in the middle of long contexts; this holds even for explicitly long-context models.

**Mechanism**: LLMs have positional biases -- information at the beginning and end of context is used more reliably than information in the middle. When grooming a long plan (many sections, many features), features in the middle sections get worse coverage in the ticket set.

**Grooming manifestation**:
- Features from the first and last sections of the plan are well-covered; middle sections produce fewer, vaguer tickets
- Non-functional requirements (security, performance, observability) buried in the middle of a plan document are underrepresented

**Severity for ticket-grooming**: Medium. Easily tested by reviewing coverage across plan sections.

---

### Failure Mode 8: Instruction-Following Degradation Under Length and Complexity

**Evidence**: AgentBench (2024) -- "poor instruction following" is one of three main failure modes; tau-bench (2024) shows pass^8 < 25%, meaning behavior is inconsistent across runs even with identical inputs.

**Mechanism**: As prompt complexity increases (long system prompts, many output fields, complex schemas), the model's reliability on each individual field degrades. JSON schema compliance, output field completeness, and format adherence all decrease as the overall task complexity increases.

**Grooming manifestation**:
- Some tickets missing the "non-goals" field
- Inconsistent formatting of acceptance criteria (some as BDD, some as free text, some as bullet points)
- File pointers in different formats across tickets
- The last tickets in a batch are less thorough than the first (generation fatigue / context window pressure)

**Severity for ticket-grooming**: Medium. Schema enforcement (constrained decoding or post-hoc validation) addresses format failures; content completeness is harder.

---

### Failure Mode 9: Ambiguity Inheritance (GIGO)

**Evidence**: LLM4SE survey (2024) -- "ambiguity in code generation poses a significant challenge"; Moharil et al. and Ezzini et al. on anaphoric ambiguity in requirements; Kambhampati et al. on specification refinement as a key role for LLMs.

**Mechanism**: Grooming converts plan-level ambiguity into ticket-level decisions without surfacing that a decision was made. When the plan says "the cache should expire appropriately," the model silently picks a specific expiration strategy and writes it into the ticket's acceptance criteria as if it were specified. The user has no visibility into the implicit decision.

**Grooming manifestation**:
- Acceptance criteria that contain specific choices (e.g., "TTL of 5 minutes") not explicitly stated in the plan
- Tickets that resolve ambiguous scope questions silently (e.g., "this ticket does NOT include iOS" when iOS was never mentioned)
- Multiple tickets that resolve the same ambiguity differently (one assumes background refresh, another assumes lazy expiration)

**Severity for ticket-grooming**: High. This is arguably the most dangerous failure mode because it is invisible -- the tickets look complete and specific, but the specifications embed hidden design decisions.

---

### Failure Mode 10: Flat World Model (Misses Cross-Cutting Concerns)

**Evidence**: Implicit in LLM4SE survey; Lilian Weng on planning challenges; CoALA (Sumers et al. 2023, arXiv:2309.02427) on the limitations of flat action spaces.

**Mechanism**: LLMs decompose features horizontally (feature A, feature B, feature C) but systematically miss vertical cross-cutting concerns: error handling, observability, security, backwards compatibility, migration strategy. These concerns are not mentioned in feature specs, so the model has no hook to generate tickets for them.

**Grooming manifestation**:
- No ticket for "add metrics/logging to the new feature"
- No ticket for "migration script for existing data"
- No ticket for "backwards compatibility shim for old API clients"
- No ticket for "error state handling in the new flow"

**Severity for ticket-grooming**: Medium-high. These missing tickets are often discovered only when an engineer tries to ship the feature and realizes they're missing infrastructure.

---

## Mitigations: Techniques and Design Patterns

### Mitigation A: External Verification Loop (LLM-Modulo Pattern)

**Addresses**: FM-1 (plan generation collapse), FM-2 (self-verification blindness), FM-10 (flat world model)

**Pattern**: Separate the generation step from the validation step. The LLM generates candidate tickets; a second pass (different LLM call, different persona, or structured checklist) validates them. The key insight from Kambhampati et al. is that the verifier must use external signals -- not just another LLM prompt asking "is this correct?"

**Concrete implementations**:
- A separate "adversarial reviewer" LLM call with explicit instructions to find missing tickets, scope problems, and dependency errors
- A checklist-based validation pass against a fixed list of cross-cutting concern categories
- Human-in-the-loop confirmation on any ticket that introduces implicit design decisions (FM-9)

**Evidence quality**: High (Kambhampati et al., Reflexion paper, AgentBench all support the value of external feedback signals over self-critique).

---

### Mitigation B: Schema-Enforced Structured Output with Field-Level Validation

**Addresses**: FM-8 (instruction-following degradation), FM-5 (hallucinated specificity in some fields), FM-3 (scope calibration through explicit size fields)

**Pattern**: Define a strict JSON schema for ticket output. Use constrained decoding (Outlines/LMQL/structured generation) or post-hoc validation with corrective regeneration (Guardrails AI) to enforce it. Each required field should have a specific format contract.

**Concrete implementations**:
- Schema includes a `size_estimate` field with enum values (XS, S, M, L, XL) to force explicit scope calibration
- Schema includes a `dependencies: []` array that must be populated (even with empty array) to prevent silent omissions
- `file_pointers` field validated against actual filesystem after generation
- `non_goals` field required -- the model cannot skip it

**Evidence quality**: High (Willard & Louf 2023 on guided generation; Eugene Yan 2023 on guardrails patterns).

---

### Mitigation C: Few-Shot Examples with Calibrated Reference Tickets

**Addresses**: FM-3 (scope calibration), FM-8 (format consistency), FM-6 (sycophantic anchoring -- anchoring to good examples instead)

**Pattern**: Provide 2-4 example ticket pairs (input fragment -> expected output ticket) in the system prompt. The examples should be from the same codebase or a similar one, and should demonstrate the desired granularity explicitly. Min et al. (2022) show that the format and label space of few-shot examples heavily anchor model output -- use this proactively.

**Concrete implementations**:
- One "too large" example with a note "this would be split into two tickets because..."
- One "right-sized" example demonstrating the format
- Examples that include non-goals to teach the model that non-goals are real and required
- Examples from the actual project if the workflow is being used repeatedly

**Evidence quality**: High (Min et al. 2022; Chain of Thought research; standard prompt engineering practice).

---

### Mitigation D: Ambiguity Surfacing Pass (Pre-Grooming)

**Addresses**: FM-9 (ambiguity inheritance), FM-6 (sycophantic drift), FM-1 (plan generation collapse)

**Pattern**: Before decomposing into tickets, run a separate prompt that asks: "What decisions does this plan leave implicit that must be resolved before the tickets can be correctly specified?" Output is a list of ambiguities. The user reviews and resolves them (or explicitly says "defer to engineer"). Only then proceed to ticket generation.

**Concrete implementations**:
- A "specification refinement" step before decomposition (one of the explicit roles Kambhampati et al. assign to LLMs)
- A field in the ticket output schema: `implicit_decisions_made: []` -- forces the model to explicitly list any assumption embedded in the ticket
- A second-pass prompt: "Review these tickets and list any place where you made a decision not explicitly specified in the plan"

**Evidence quality**: High (Kambhampati et al. on specification refinement as the right role for LLMs; hallucination survey on how LLMs fill gaps silently).

---

### Mitigation E: Cross-Cutting Concern Checklist Injection

**Addresses**: FM-10 (flat world model), FM-2 (self-verification blindness)

**Pattern**: Inject a fixed list of cross-cutting concern categories into the prompt: error handling, observability/metrics, security, backwards compatibility, data migration, rollback plan, test coverage. After ticket generation, run a validation pass: "For each cross-cutting concern category, is there a ticket or an explicit non-goal? If not, create one."

**Concrete implementations**:
- Append a checklist table to the system prompt: "After generating all feature tickets, run through this checklist"
- Use a separate second-pass LLM call specifically focused on cross-cutting concerns
- Include "observability" and "error handling" as required sub-fields of each feature ticket (even if just "handled in existing error framework")

**Evidence quality**: Medium-high (from practitioner experience and inference from "flat world model" failure mode; not from a specific empirical study on grooming).

---

### Mitigation F: Sequential Decomposition with Incremental Context

**Addresses**: FM-7 (context window and position sensitivity), FM-4 (dependency blindness)

**Pattern**: Don't try to generate all tickets in one pass. Process the plan section by section, accumulating a "tickets generated so far" summary. Each new section's tickets are generated with awareness of existing tickets, enabling dependency detection.

**Concrete implementations**:
- Least-to-Most prompting pattern: generate the prerequisite/infrastructure tickets first, then generate feature tickets that reference them
- A "dependency graph" pass at the end: "Given all generated tickets, identify all blocking relationships"
- Chunk the plan into logical sections; process each section with a fresh context window but a running summary of previously generated tickets

**Evidence quality**: High (Least-to-Most prompting Zhou et al. 2023; Lost in the Middle Liu et al. 2023; AgentBench on long-horizon reasoning failures).

---

### Mitigation G: File Pointer Grounding Against Codebase

**Addresses**: FM-5 (hallucinated specificity)

**Pattern**: After ticket generation, extract all file pointers and validate them against the actual file system. For any file pointer that doesn't exist, either reject and regenerate or flag for human review. Optionally, run a pre-grounding step: provide the model with an actual file listing of relevant directories before asking for file pointers.

**Concrete implementations**:
- Post-generation file pointer validation script (bash/Python)
- Provide a `tree -d -L 3` output of the relevant module in the ticket prompt context
- Use a RAG lookup for "files related to this domain" as context before generating file pointers

**Evidence quality**: High (hallucination survey; empirical observation that LLMs hallucinate file paths; guided generation research showing grounding reduces hallucination).

---

### Mitigation H: Persona Separation for Generation vs. Review

**Addresses**: FM-2 (self-verification blindness), FM-6 (sycophantic drift)

**Pattern**: Use two separate LLM calls with distinct system prompts and explicit different roles: one is the "ticket author" who drafts tickets without criticism; one is the "skeptical tech lead" who reviews for scope problems, missing tickets, implicit decisions, and unrealistic acceptance criteria.

The key is that the reviewer persona has explicit instructions to find problems -- not to validate the existing work.

**Concrete implementations**:
- System prompt A: "You are a thorough engineer grooming a backlog. Produce complete ticket stubs."
- System prompt B: "You are a skeptical tech lead reviewing these tickets. Your job is to find what's wrong, missing, or unclear. Be adversarial."
- A third pass: "Given the reviewer's concerns, revise the following tickets"

**Evidence quality**: Medium-high (sycophancy research; Reflexion paper on the value of explicit feedback roles; Kambhampati et al. on "soft critics" using LLMs).

---

### Mitigation I: Explicit Non-Goal Elicitation

**Addresses**: FM-3 (scope calibration), FM-9 (ambiguity inheritance), FM-6 (sycophantic anchoring)

**Pattern**: Explicitly prompt for non-goals in the system prompt, and include a validation pass that checks whether stated non-goals are plausible exclusions (not just "we won't rewrite the database"). The model tends to write non-goals that are trivially out of scope ("this ticket does not include deploying to production") rather than useful scope boundaries.

**Concrete implementations**:
- Add to the system prompt: "Non-goals should be things that an engineer might reasonably think are in scope but are not"
- Add a validation check: "For each ticket, is at least one non-goal a meaningful exclusion that a reasonable engineer would question?"
- Few-shot examples showing good vs. bad non-goals

**Evidence quality**: Medium (practitioner experience; inference from scope calibration failure mode).

---

## Design Patterns Summary Table

| Mitigation | Failure Modes Addressed | Evidence Quality | Implementation Cost |
|---|---|---|---|
| A: External verification loop | FM-1, FM-2, FM-10 | High (Kambhampati, Reflexion) | Medium |
| B: Schema-enforced structured output | FM-8, FM-5, FM-3 | High (Outlines, Guardrails) | Low |
| C: Few-shot calibrated examples | FM-3, FM-8, FM-6 | High (Min et al.) | Low |
| D: Ambiguity surfacing pre-pass | FM-9, FM-6, FM-1 | High (Kambhampati spec refinement) | Medium |
| E: Cross-cutting concern checklist | FM-10, FM-2 | Medium-high | Low |
| F: Sequential incremental context | FM-7, FM-4 | High (Least-to-Most, Lost-in-Middle) | Medium |
| G: File pointer grounding | FM-5 | High (hallucination surveys) | Low-Medium |
| H: Persona separation (author + reviewer) | FM-2, FM-6 | Medium-high (sycophancy research) | Medium |
| I: Explicit non-goal elicitation | FM-3, FM-9, FM-6 | Medium | Low |

---

## Candidate Directions for the Ticket-Grooming Workflow

Three structural approaches exist, each with different priority orderings of the mitigations:

### Direction 1: Schema-First (Low Ceremony, High Structure)

**Core idea**: Put most of the reliability investment into the output schema and constrained generation. Use a very strict Pydantic-like schema with field-level validation. Run a single generation pass with a strong system prompt, then validate the output mechanically.

**Implements**: B (schema), C (few-shot), G (file pointer grounding), E (cross-cutting checklist embedded in schema)

**Tradeoffs**:
- Pros: Simple, cheap, fast, deterministic format
- Cons: Doesn't address FM-1 (plan generation gaps), FM-9 (ambiguity inheritance), FM-2 (self-verification blindness)
- When it wins: Input plans are well-specified, team has high trust in LLM judgment, grooming sessions are light review gates

### Direction 2: Multi-Pass with External Verification (High Confidence, Medium Ceremony)

**Core idea**: Three passes -- (1) ambiguity surfacing, (2) ticket generation, (3) adversarial review. Each pass is a separate LLM call with a distinct persona and purpose.

**Implements**: A (external verification), D (ambiguity surfacing), H (persona separation), B (schema), E (cross-cutting checklist), I (non-goal elicitation)

**Tradeoffs**:
- Pros: Addresses the most dangerous failure modes (FM-9, FM-2); produces higher-quality output
- Cons: More expensive (3x LLM calls), more complex workflow, ambiguity surfacing creates extra friction
- When it wins: Plans are ambiguous or novel; output is going to a team that will execute without PM oversight; failures are expensive

### Direction 3: Human-in-the-Loop Checkpoint Design

**Core idea**: Use the LLM aggressively for draft generation but insert a mandatory human checkpoint at every structurally important decision point: ambiguity resolution, dependency graph review, scope calibration.

**Implements**: A (external verification = human), D (ambiguity surfacing -> human confirms), C (few-shot from team's own tickets)

**Tradeoffs**:
- Pros: Highest quality; treats LLM as intelligent draft assistant, not autonomous agent; consistent with Kambhampati et al.'s recommendation
- Cons: Highest friction; defeats the purpose of automation for rapid grooming
- When it wins: High-stakes tickets (foundational architecture changes, complex data migrations); large plan documents where a human review catches issues the model misses

---

## Challenge Notes

**Challenge to Direction 1 (Schema-First)**:
The schema guarantees *format* completeness, not *content* completeness. A ticket can have all fields populated and still miss critical scope boundaries, contain hallucinated file paths, or embed silent design decisions. Schema enforcement is necessary but not sufficient. This direction is likely to produce a false sense of thoroughness.

**Challenge to Direction 2 (Multi-Pass)**:
The adversarial review pass still has the FM-2 problem -- the reviewer LLM cannot reliably catch errors it doesn't know to look for. An adversarial persona helps with sycophancy but not with the underlying inability to verify plan correctness. The approach also assumes the ambiguity surfacing pass will catch the right ambiguities -- but the model only knows to ask about ambiguities it can perceive, not ambiguities invisible to it.

**Challenge to Direction 3 (Human-in-the-Loop)**:
Requiring human checkpoints at every decision point is equivalent to manually grooming with LLM assistance. This is a valid and often correct approach, but it's not a "workflow" -- it's a tool usage pattern. If the team has the bandwidth for this, the LLM is providing draft quality acceleration, not grooming quality acceleration.

---

## Resolution Notes

**Selected direction**: Direction 2 (Multi-Pass with External Verification) as the default for the ticket-grooming workflow, with Direction 1 (Schema-First) as a fast path for well-specified inputs.

**Rationale**:
- The most dangerous failure modes for a grooming workflow are FM-9 (ambiguity inheritance) and FM-2 (self-verification blindness). These produce invisible errors -- tickets that look correct but encode wrong design decisions or miss critical dependencies.
- Direction 2 is the only one that directly addresses these with an architectural separation of concerns (generate vs. verify) rather than relying on the same LLM to catch its own mistakes.
- The three-pass structure maps directly to the cognitive work a good human groomer does: understand ambiguity, draft tickets, review critically.

**Residual risks of Direction 2**:
- The reviewer pass cannot catch ambiguities that are invisible to the model (FM-9 partial mitigation only)
- Dependency graph validation still relies on LLM judgment without an external oracle
- File pointer hallucinations require a non-LLM grounding step (grep/find against the codebase)

**Confidence band**: STANDARD -- research evidence on the core failure modes is solid; the specific effectiveness of Direction 2 on grooming tasks lacks empirical validation (no grooming-specific benchmark exists).

---

## Decision Log

**2026-04-02**: Chose `landscape_first` path -- research synthesis task, clear question, no design ambiguity.

**2026-04-02**: Identified 10 core failure modes from research evidence. Most severe for grooming: FM-1 (plan generation collapse), FM-2 (self-verification blindness), FM-9 (ambiguity inheritance).

**2026-04-02**: Selected Direction 2 (Multi-Pass with External Verification) as primary recommendation, with Direction 1 as fast-path alternative. Direction 3 rejected as workflow design because it's really a usage pattern.

**Key insight from planning research**: The critical architectural lesson from Kambhampati et al. is that the "Generate-Test-Critique" loop is the right pattern, but only if "Test" uses external signals, not LLM self-reflection. For ticket grooming, the best available "external signal" is a structured checklist (cross-cutting concerns, dependency graph, ambiguity markers) plus human review of implicit decisions.

---

## Final Summary

**Research question answered**: AI agents doing ticket/backlog grooming fail in ten predictable ways, grouped into three root causes:

1. **Fundamental planning limitations** (FM-1, FM-2): LLMs cannot generate complete, correct plans autonomously, and cannot self-verify. This is not a prompt engineering problem -- it is a structural property of auto-regressive token prediction. The mitigation is external verification loops, not better self-critique prompts.

2. **Context and specificity failures** (FM-3, FM-5, FM-7, FM-8): Scope calibration, hallucinated file paths, position-sensitivity, and instruction-following degradation. These are addressed by schema enforcement, few-shot calibration, and sequential processing.

3. **Invisible content failures** (FM-4, FM-6, FM-9, FM-10): Dependency blindness, sycophantic anchoring, ambiguity inheritance, and flat world model. These are the most dangerous because they produce tickets that look right but encode wrong decisions. Mitigated by explicit ambiguity surfacing passes, cross-cutting concern checklists, and persona-separated adversarial review.

**What this means for the ticket-grooming workflow**:

The WorkRail `ticket-grooming` workflow should be stress-tested against these specific scenarios:
1. A plan with intentional ambiguities (does the model surface them or silently resolve them?)
2. A plan with cross-cutting concerns not explicitly mentioned (does the model miss infrastructure tickets?)
3. A plan with hidden dependencies (does the ticket set have a dependency order that is actually correct?)
4. A plan referencing specific files (are the file pointers real or hallucinated?)
5. A multi-section plan of medium length (are sections in the middle covered as well as sections at the start and end?)

**Sources consulted**:
- Kambhampati et al. (2024). "LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks." arXiv:2402.01817
- Valmeekam et al. (2023). "On the Planning Abilities of Large Language Models." arXiv:2302.06706
- Valmeekam et al. (2023). "PlanBench: An Extensible Benchmark." arXiv:2206.10498
- Yao et al. (2023). "Tree of Thoughts." arXiv:2305.10601 [NeurIPS 2023]
- Besta et al. (2024). "Graph of Thoughts." arXiv:2308.09687 [AAAI 2024]
- Shinn et al. (2023). "Reflexion." arXiv:2303.11366
- Liu et al. (2023). "Lost in the Middle." arXiv:2307.03172 [TACL]
- Liu et al. (2024). "AgentBench." arXiv:2308.03688 [ICLR 2024]
- Jimenez et al. (2024). "SWE-bench." arXiv:2310.06770 [ICLR 2024]
- Yao et al. (2024). "tau-bench." arXiv:2406.12045
- Wei et al. (2023). "Simple synthetic data reduces sycophancy." arXiv:2308.03958
- Min et al. (2022). "Rethinking the Role of Demonstrations." arXiv:2202.12837 [EMNLP 2022]
- Zhou et al. (2023). "Least-to-Most Prompting." arXiv:2205.10625 [ICLR 2023]
- Huang et al. (2023). "Hallucination survey." arXiv:2311.05232 [ACM TOIS]
- Willard & Louf (2023). "Efficient Guided Generation." arXiv:2307.09702
- Hou et al. (2024). "LLMs for SE: A Systematic Literature Review." arXiv:2308.10620
- Sumers et al. (2024). "CoALA: Cognitive Architectures for Language Agents." arXiv:2309.02427 [TMLR]
- Wang et al. (2023). "A Survey on LLM-based Autonomous Agents." arXiv:2308.11432
- Weng, L. (2023). "LLM-powered Autonomous Agents." lilianweng.github.io
- Yan, E. (2023). "Patterns for Building LLM-based Systems & Products." eugeneyan.com
