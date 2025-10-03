# Root Cause Display Fix

## Problem
The Root Cause section was:
1. Showing as "Pending" even when investigation was complete with high confidence
2. Missing fields like `description` and `component`
3. Using different field names than the actual data structure

## Root Cause
The scaffold's `rootCause()` builder was:
- Looking for `data.summary` but the actual field was `data.description`
- Looking for `data.location` but some data used `data.file`
- Not checking confidence level to auto-determine status
- Not showing the `component` field

## Fix Applied

### Updated `rootCause()` Builder in `/web/assets/scaffolds/dashboard.js`

**Flexible Field Mapping:**
```javascript
const location = data.location || data.file;
const summary = data.summary || data.description;
const component = data.component;
const confidence = data.confidence;
```

**Smart Status Detection:**
```javascript
// Auto-confirm if confidence >= 8
let status = data.status;
if (!status && confidence >= 8) {
  status = 'confirmed';
}
```

**Component Display:**
Added a new section to show the component name if available.

**Confidence Formatting:**
Changed from `${confidence}/10` to `${confidence.toFixed(1)}/10` for proper decimal display.

## Bonus Fixes
- **Removed file duplications**: Both `dashboard.js` and `dashboard-v3.html` had accidental duplications (file was pasted twice)
- **Added missing closing braces**: File was truncated during cleanup

## Result
✅ Root Cause now shows "Confirmed" status when confidence >= 8  
✅ All fields (component, location, description, confidence) display correctly  
✅ Handles both `location`/`file` and `summary`/`description` field names  
✅ No more "Pending" status on completed investigations

