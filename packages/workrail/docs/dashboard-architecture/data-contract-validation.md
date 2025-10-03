# Data Contract Validation for Dashboard Integrity

## Problem Statement

**Can agents break the dashboard with incorrect data?** 

**YES.** Examples we've encountered:
- Using `item` instead of `title` for ruled out hypotheses → showed "Untitled"
- Missing `component` field in root cause → hero didn't show "complete" state
- Wrong field types could cause `NaN`, `undefined`, or crashes

## Risk Assessment

### High-Risk Scenarios
1. **Missing Required Fields**: Dashboard renders blank/broken cards
2. **Wrong Data Types**: `progress: "85%"` (string) instead of `85` (number) → math operations fail
3. **Invalid Enum Values**: `status: "finished"` instead of `"complete"` → wrong badge styling
4. **Array Structure Mismatch**: Timeline events with inconsistent schemas → map errors
5. **Nested Object Issues**: `rootCause.location` missing → `Cannot read property of undefined`

### Current Protection Level
**LOW** - Dashboard uses defensive checks (`r.item || r.title || 'Untitled'`) but not comprehensive

---

## Solution Proposals

### **Approach 1: Schema Validation at Write Time** ⭐ RECOMMENDED

**Concept**: Validate all session data before writing to `~/.workrail/sessions/`

**Implementation**:
```typescript
// In SessionManager.updateSession()
const validationResult = validateSessionData(workflowId, updates);
if (!validationResult.valid) {
  throw new Error(`Invalid data: ${validationResult.errors.join(', ')}`);
}
await this.writeSessionFile(sessionPath, updatedData);
```

**Pros**:
- ✅ Catches errors early (at agent write time)
- ✅ Agent gets immediate feedback via error message
- ✅ Dashboard never sees invalid data
- ✅ Single source of truth for schema

**Cons**:
- ❌ Strict validation might block valid but slightly different data
- ❌ Schema evolution becomes harder (breaking changes)
- ❌ Agent errors if it gets schema wrong (could interrupt workflow)

**Best For**: Production systems where data integrity is critical

---

### **Approach 2: Defensive Rendering with Graceful Fallbacks**

**Concept**: Dashboard handles all possible data variations gracefully

**Implementation**:
```javascript
// Current approach (enhanced)
function renderRootCauseCard(rootCause) {
  const location = rootCause?.location 
    || rootCause?.file 
    || rootCause?.path 
    || 'Unknown location';
  
  const description = rootCause?.description 
    || rootCause?.explanation 
    || rootCause?.summary 
    || 'No description provided';
  
  // Even if fields are completely missing, render something useful
  if (!rootCause || Object.keys(rootCause).length === 0) {
    return renderPlaceholderCard('Root cause investigation in progress...');
  }
  
  // Render with available data
}
```

**Pros**:
- ✅ Dashboard never crashes
- ✅ Flexible - accepts multiple field name variants
- ✅ Good developer experience (shows partial data)
- ✅ No workflow interruption

**Cons**:
- ❌ Hides data quality issues
- ❌ Can lead to "garbage in, garbage out"
- ❌ More code to maintain
- ❌ Harder to debug (why is it showing fallback?)

**Best For**: Development/experimentation phase, flexible workflows

---

### **Approach 3: Runtime Type Guards + Validation Warnings** ⭐ RECOMMENDED

**Concept**: Validate data when dashboard loads it, log warnings but don't fail

**Implementation**:
```typescript
// In SessionManager.getSession()
const session = await this.readSessionFile(sessionPath);

const validation = validateSessionData(workflowId, session.data);
if (!validation.valid) {
  console.warn(`[SessionManager] Data quality issues in ${workflowId}/${sessionId}:`, 
    validation.warnings);
  
  // Log to file for debugging
  await this.logValidationWarnings(workflowId, sessionId, validation.warnings);
}

// Return data anyway (dashboard handles it defensively)
return session;
```

**Dashboard Side**:
```javascript
// Show validation banner if issues detected
if (sessionData._validationWarnings) {
  showValidationBanner(sessionData._validationWarnings);
}
```

**Pros**:
- ✅ Best of both worlds - warns but doesn't break
- ✅ Debugging information available
- ✅ Can track data quality over time
- ✅ Non-breaking for agents

**Cons**:
- ❌ Warnings might be ignored
- ❌ Extra logging overhead
- ❌ Requires good monitoring

**Best For**: Production with observability, gradual schema evolution

---

### **Approach 4: Data Normalization Layer**

**Concept**: Transform flexible agent input to strict internal schema

**Implementation**:
```typescript
class SessionDataNormalizer {
  normalizeRootCause(data: any): RootCause {
    return {
      identified: data.identified ?? false,
      location: data.location || data.file || data.path || 'unknown',
      description: data.description || data.explanation || data.summary || '',
      confidence: parseFloat(data.confidence) || 0,
      code: data.code || '',
      evidence: Array.isArray(data.evidence) ? data.evidence : []
    };
  }
  
  normalizeRuledOut(items: any[]): RuledOutItem[] {
    return items.map(item => ({
      id: item.id || item.hypothesisId || null,
      title: item.item || item.title || item.hypothesis || 'Untitled',
      reason: item.reason || 'No reason provided',
      timestamp: item.timestamp || new Date().toISOString(),
      phase: item.phase || 'unknown'
    }));
  }
}
```

**Used in**:
```javascript
// Dashboard
const normalizedData = normalizer.normalize(rawSessionData);
renderDashboard(normalizedData);
```

**Pros**:
- ✅ Clean separation of concerns
- ✅ Dashboard only sees normalized data
- ✅ Easy to support multiple schema versions
- ✅ Can fix common issues automatically

**Cons**:
- ❌ Extra abstraction layer
- ❌ Could mask real problems
- ❌ Normalization logic needs maintenance

**Best For**: Multi-version support, evolving schemas

---

### **Approach 5: Schema Documentation + Agent Examples** ⭐ RECOMMENDED

**Concept**: Make it easy for agents to get it right the first time

**Implementation**:

1. **Comprehensive Schema Docs**:
```markdown
# Bug Investigation Session Schema

## Root Cause Object
\`\`\`typescript
{
  identified: boolean;        // REQUIRED
  location: string;           // REQUIRED - file path with line number
  description: string;        // REQUIRED - what went wrong
  confidence: number;         // REQUIRED - 0-10
  code?: string;              // OPTIONAL - problematic code snippet
  evidence?: string[];        // OPTIONAL - list of evidence
}
\`\`\`
```

2. **$schema Query Support** (already implemented!):
```javascript
// Agent can call
workrail_read_session("bug-investigation", "AUTH-1234", "$schema")
// Returns example structure
```

3. **Example Sessions**:
```json
// ~/.workrail/examples/bug-investigation-complete.json
{
  "dashboard": { "status": "complete", "progress": 100, ... },
  "rootCause": { "identified": true, "location": "...", ... }
}
```

4. **Inline Documentation in Workflow**:
```json
{
  "guidance": "Use workrail_update_session() with this structure:\n
    rootCause: {\n
      identified: true,\n
      location: 'file.ts:42',\n
      description: 'Race condition...',\n
      confidence: 9.5\n
    }"
}
```

**Pros**:
- ✅ Prevents problems at the source
- ✅ Good developer experience
- ✅ Self-documenting
- ✅ No runtime overhead

**Cons**:
- ❌ Agents still might make mistakes
- ❌ Docs can get out of sync
- ❌ Doesn't prevent errors, just reduces them

**Best For**: All systems (foundational approach)

---

## Recommended Combination

**For Workrail Bug Investigation Dashboard:**

### Phase 1: Quick Wins (Now)
1. ✅ **Approach 2** - Add more defensive fallbacks throughout dashboard
2. ✅ **Approach 5** - Document the exact schema in `bug-investigation-session-schema.md` (already done!)
3. ✅ **Approach 5** - Update workflow guidance with correct field names

### Phase 2: Production Hardening (Next)
4. ⭐ **Approach 3** - Add runtime validation with warnings (non-blocking)
5. ⭐ **Approach 4** - Add data normalization layer for common variations

### Phase 3: Long Term (Future)
6. **Approach 1** - Consider strict validation for critical fields only
7. **Versioned Schemas** - Support v1, v2, etc. with migration

---

## Implementation Priority

### Critical (Do First)
- [ ] Audit all dashboard render functions for defensive checks
- [ ] Add try-catch around all `map()` operations
- [ ] Handle `null`, `undefined`, and empty arrays gracefully

### High Priority
- [ ] Implement data normalization layer
- [ ] Add validation warnings to SessionManager
- [ ] Create example sessions for agents to reference

### Medium Priority
- [ ] Add validation banner in dashboard UI
- [ ] Log validation issues for monitoring
- [ ] Create schema validation library

### Low Priority (Nice to Have)
- [ ] Strict validation mode (opt-in)
- [ ] Schema versioning system
- [ ] Automated schema testing

---

## Testing Strategy

### Unit Tests
```typescript
describe('Dashboard Defensive Rendering', () => {
  it('renders root cause card with missing fields', () => {
    const result = renderRootCauseCard({});
    expect(result).toContain('Unknown location');
  });
  
  it('handles ruled out with only reason field', () => {
    const result = renderRuledOutCard([{ reason: 'test' }]);
    expect(result).toContain('Untitled Hypothesis');
  });
});
```

### Integration Tests
```typescript
describe('Session Data Normalization', () => {
  it('normalizes multiple field name variants', () => {
    const variants = [
      { location: 'file.ts:10' },
      { file: 'file.ts:10' },
      { path: 'file.ts:10' }
    ];
    
    variants.forEach(data => {
      const normalized = normalizer.normalizeRootCause(data);
      expect(normalized.location).toBe('file.ts:10');
    });
  });
});
```

### E2E Tests
- Test dashboard with completely empty session
- Test dashboard with partially filled session
- Test dashboard with invalid data types
- Test dashboard with extra unknown fields

