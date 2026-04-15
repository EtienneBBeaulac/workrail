# Design Review Findings
## Competitive Landscape: Structured Workflow Enforcement for AI Agents

> **Input**: `design-candidates-workflow-enforcement.md`
> **Selected direction**: C1+C3 combined + Temporal vocabulary from C2
> **Reviewer**: main agent (no subagent delegation for review; landscape_first rigor)

---

## Tradeoff Review

### Tradeoff 1: Adoption friction accepted (C1 owns deliberate-adoption niche)
- **Status**: Acceptable under current conditions
- **Will violate criteria when**: Goal shifts from accurate positioning to maximize-adoption
- **Hidden assumption**: Engineers who have experienced enforcement failures are the right
  initial market. If primary users are non-engineers, this assumption needs re-examination.

### Tradeoff 2: Platform risk accepted (Zodiac/SET may build competing workflow layer)
- **Status**: Acceptable; risk is real but timing is uncertain (years, not months)
- **Will violate criteria when**: Zodiac/SET announce a specific timeline with team + budget
- **Hidden assumption**: '2026 Engineering AI Strategy' reference to SET owning workflow
  platform is aspirational, not describing a funded near-term project.

### Tradeoff 3: Study investment deferred (C2 not immediate)
- **Status**: Acceptable; no crash-recovery failures observed
- **Will violate criteria when**: WorkRail sessions fail to recover via checkpoint token
- **Hidden assumption**: Current `snapshot-store.port.ts` is sufficient for observed durability requirements.

---

## Failure Mode Review

### FM1: LangGraph adds MCP-server exposure
- **Severity**: ORANGE
- **Design coverage**: Named as riskiest assumption with watch condition. No explicit response action.
- **Missing mitigation**: If LangGraph ships MCP-server support, positioning must shift immediately
  to 'JSON-authored workflows + token-gated cryptographic enforcement' as the remaining moat.
  This response is implicit in the design but not written as an explicit action.

### FM2: CIAME is demand signal, not guaranteed adopter
- **Severity**: YELLOW (scoped correctly)
- **Design coverage**: Correctly framed as 'discovery conversation,' not 'committed customer.'
- **Missing mitigation**: None material.

### FM3: Zodiac/SET builds competing workflow execution layer
- **Severity**: ORANGE
- **Design coverage**: Named as a framing risk with watch condition. No escalation path defined.
- **Missing mitigation**: If Zodiac/SET announce a workflow execution timeline, the response
  is not specified. Should be: accelerate C3 (list immediately) + accelerate C2 (begin
  architectural deepening to establish feature differentiation before platform feature parity).

---

## Runner-Up / Simpler Alternative Review

### Runner-up (C2) elements worth pulling in
- **Temporal vocabulary as positioning anchor**: 'If you know Temporal.io, think of WorkRail
  as Temporal for AI agent process governance via MCP.' This is a sentence, not a project.
  Zero cost, adds communicative value for engineers evaluating durable workflow tools.
- **Decision**: Pull this vocabulary into C1's positioning language. Add to design doc
  Final Summary section.

### Simpler alternative: C1 alone (without C3)
- **Would satisfy**: External competitive map requirement
- **Would miss**: Internal visibility gap (CIAME, Zodiac catalog absence) -- the most concrete
  actionable finding in the research
- **Verdict**: C1 alone is technically sufficient but leaves the best internal finding unaddressed.
  C3 is zero-cost and closes the most concrete gap.

---

## Philosophy Alignment

- **Make illegal states unrepresentable**: Fully satisfied -- C1's positioning IS this principle
- **Surface information, don't hide it**: Fully satisfied -- C3 implements this
- **YAGNI with discipline**: Fully satisfied -- C2 deferred correctly
- **Determinism over cleverness**: Satisfied -- all claims are falsifiable, not vague
- **Architectural fixes over patches**: Mild productive tension with narrow positioning scope;
  acceptable because YAGNI principle explicitly limits scope to demonstrated need

---

## Findings

### RED: None

### ORANGE: Two missing mitigations

**O1 -- LangGraph MCP-server response action not specified**
The design identifies LangGraph adding MCP-server exposure as the riskiest assumption but
does not specify what WorkRail should do when this happens. The response needs to be written
explicitly:

> If LangGraph ships MCP-server support: update positioning to lead with 'JSON-authored
> workflows + token-gated cryptographic enforcement' as the two remaining axes. The MCP-native
> claim becomes 'WorkRail is an MCP server that enforces steps cryptographically; LangGraph is
> an MCP client that does not.'

**O2 -- Zodiac/SET escalation path not specified**
The design identifies the platform risk but does not specify the escalation response.

> If Zodiac/SET announce a workflow execution layer timeline: treat C3 as table stakes
> (list immediately), accelerate C2 (begin architectural deepening to establish differentiation
> before feature parity). The monitor-and-respond window is gone; it becomes a race.

### YELLOW: Three items

**Y1 -- Internal market assumption unverified**
The design assumes engineers who have experienced enforcement failures are the right initial
market. This assumption has not been validated. The CIAME case suggests a non-engineering
team member (project manager with migration scripts) might be a different persona.

**Y2 -- Zodiac listing process unknown**
The design recommends listing WorkRail in the Zodiac AI Marketplace and ZG AI Tools Catalog
but the actual process for self-submitting an MCP to Zodiac has not been investigated.

**Y3 -- 2026 AI Strategy timeline unknown**
The 'SET owns workflow platform' statement could be describing a funded near-term project.
No follow-up was done to determine if there's a team and budget behind it.

---

## Recommended Revisions

1. **Add FM1 mitigation to design doc**: Write the explicit LangGraph MCP-server response action
   (O1) into the Final Summary / Key Findings section.

2. **Add FM3 escalation path to design doc**: Write the Zodiac/SET timeline response (O2) into
   the Challenge Notes or Final Summary.

3. **Pull C2 vocabulary into design doc**: Add the Temporal comparison sentence to the
   'Projects WorkRail Should Study' section and the Final Summary.

4. **Flag Y2 and Y3 as open questions**: Add to design doc's open questions: (a) what is the
   Zodiac self-submission process for MCPs, and (b) is there a team/budget behind the 2026
   Strategy's 'SET owns workflow platform' statement.

---

## Residual Concerns

- The highest-risk failure mode (LangGraph MCP-server) is technically plausible in the near
  term (6-18 months). LangGraph already generates MCP schemas for introspection. The gap
  between 'generates schemas for MCP introspection' and 'exposes workflows as MCP tools' is
  a product decision, not a technical blocker.

- WorkRail's internal visibility gap (not in ZG AI Tools Catalog) is a concrete, immediately
  actionable gap with no architecture cost to close. This is the single most actionable
  finding from the entire research effort.
