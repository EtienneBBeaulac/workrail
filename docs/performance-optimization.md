# Dashboard Performance Optimization

The dashboard includes several performance optimization features to handle large datasets efficiently.

## Features

### 1. Memoization

Expensive computations are cached to avoid redundant work:

```javascript
import { memoize } from '@workrail/utils/performance';

// Memoize expensive function
const expensiveCalculation = memoize((input) => {
  // Heavy computation
  return result;
}, { maxSize: 100 });
```

**Built-in Memoization:**
- `PatternRecognizer.formatLabel()` - Field name formatting
- Pattern recognition results are cached

### 2. Debouncing & Throttling

Limit function call frequency:

```javascript
import { debounce, throttle } from '@workrail/utils/performance';

// Debounce: Execute after delay
const debouncedSearch = debounce((query) => {
  performSearch(query);
}, 300);

// Throttle: Limit execution rate
const throttledScroll = throttle(() => {
  handleScroll();
}, 100);
```

### 3. Virtual Scrolling

Render only visible items for large lists:

```javascript
import { VirtualScroll } from '@workrail/utils/performance';

const virtualScroll = new VirtualScroll(container, {
  itemHeight: 50,  // Height of each item in pixels
  buffer: 5        // Extra items to render above/below viewport
});

// Set items
virtualScroll.setItems(largeArray);

// Custom rendering
virtualScroll.renderItem = (item, index) => {
  const div = document.createElement('div');
  div.textContent = item.name;
  return div;
};
```

**Benefits:**
- Handles 10,000+ items smoothly
- Constant memory usage
- 60fps scrolling

### 4. Incremental Rendering

Break large rendering tasks into chunks:

```javascript
import { IncrementalRenderer } from '@workrail/utils/performance';

const renderer = new IncrementalRenderer({
  chunkSize: 10,      // Items per chunk
  chunkDelay: 16,     // Delay between chunks (ms)
  onProgress: (current, total) => {
    console.log(`Rendered ${current}/${total} items`);
  }
});

await renderer.render(items, (item) => {
  // Render single item
  return createItemElement(item);
}, container);
```

**Benefits:**
- UI remains responsive
- Shows progress
- Prevents browser freezing

### 5. Smart Diff

Efficiently compute and apply data changes:

```javascript
import { SmartDiff } from '@workrail/utils/performance';

const diff = new SmartDiff();

// Compute changes
const changes = diff.diff(oldData, newData);

console.log(changes.added);     // New fields
console.log(changes.removed);   // Deleted fields
console.log(changes.modified);  // Changed fields

// Apply changes to DOM
diff.applyDiff(changes, container, (path, value) => {
  return renderField(path, value);
});
```

**Benefits:**
- Only updates changed elements
- Preserves UI state
- Reduces DOM operations

### 6. Batch Scheduling

Batch DOM updates for better performance:

```javascript
import { batchScheduler } from '@workrail/utils/performance';

// Schedule updates - all execute in single frame
batchScheduler.schedule(() => {
  element1.textContent = 'Updated';
});

batchScheduler.schedule(() => {
  element2.classList.add('active');
});

// Both execute together in next animation frame
```

### 7. Performance Monitoring

Track render times and identify bottlenecks:

```javascript
import { perfMonitor } from '@workrail/utils/performance';

// Mark points
perfMonitor.mark('operation-start');
// ... expensive operation ...
perfMonitor.mark('operation-end');

// Measure duration
const duration = perfMonitor.measure('Operation', 'operation-start', 'operation-end');
console.log(`Operation took ${duration}ms`);

// Generate report
perfMonitor.report();
```

**Dashboard Integration:**
```javascript
GenericDashboard({
  workflowId: 'test',
  sessionId: 'TEST-001',
  enablePerformanceMonitoring: true  // Enable monitoring
});

// Check console for performance warnings
// ⚠️ Slow render: 150.23ms
```

## Best Practices

### 1. Use Virtual Scrolling for Large Lists

**Before:**
```javascript
// Renders ALL items (slow for 1000+ items)
for (const item of items) {
  container.appendChild(renderItem(item));
}
```

**After:**
```javascript
// Renders only visible items (fast for any size)
const virtualScroll = new VirtualScroll(container, { itemHeight: 50 });
virtualScroll.setItems(items);
```

### 2. Memoize Expensive Computations

**Before:**
```javascript
function processData(data) {
  // Expensive parsing/transformation
  return expensiveOperation(data);
}

// Called repeatedly with same data
const result1 = processData(data);
const result2 = processData(data); // Redundant work!
```

**After:**
```javascript
const processData = memoize((data) => {
  return expensiveOperation(data);
});

// Second call returns cached result
const result1 = processData(data);  // Computes
const result2 = processData(data);  // Cached!
```

### 3. Debounce Frequent Events

**Before:**
```javascript
input.addEventListener('input', (e) => {
  // Called on EVERY keystroke
  expensiveSearch(e.target.value);
});
```

**After:**
```javascript
const debouncedSearch = debounce((query) => {
  expensiveSearch(query);
}, 300);

input.addEventListener('input', (e) => {
  // Called only after user stops typing
  debouncedSearch(e.target.value);
});
```

### 4. Use Incremental Rendering

**Before:**
```javascript
// Renders all at once (blocks UI)
for (const item of largeArray) {
  container.appendChild(renderItem(item));
}
```

**After:**
```javascript
// Renders incrementally (UI stays responsive)
const renderer = new IncrementalRenderer({ chunkSize: 20 });
await renderer.render(largeArray, renderItem, container);
```

### 5. Batch DOM Updates

**Before:**
```javascript
// Multiple reflows/repaints
element1.style.width = '100px';  // Reflow
element2.style.height = '50px';  // Reflow
element3.classList.add('active'); // Reflow
```

**After:**
```javascript
// Single reflow/repaint
batchScheduler.schedule(() => {
  element1.style.width = '100px';
  element2.style.height = '50px';
  element3.classList.add('active');
});
```

## Performance Targets

**Recommended targets for optimal UX:**

| Operation | Target | Warning | Critical |
|-----------|--------|---------|----------|
| Initial render | < 100ms | 100-300ms | > 300ms |
| Update render | < 50ms | 50-100ms | > 100ms |
| Scroll (60fps) | < 16ms | 16-32ms | > 32ms |
| User interaction | < 100ms | 100-300ms | > 300ms |

## Monitoring

Enable performance monitoring in development:

```javascript
GenericDashboard({
  workflowId: 'test',
  sessionId: 'TEST-001',
  enablePerformanceMonitoring: true
});
```

**Console output:**
```
⚡ Performance Report
  Dashboard Render: 45.23ms
  Pattern Recognition: 12.45ms
  DOM Update: 8.91ms
```

## Troubleshooting

### Slow Initial Render

**Symptoms:** First render takes > 300ms

**Solutions:**
1. Use incremental rendering for large datasets
2. Enable performance monitoring to identify bottleneck
3. Check if pattern recognition is slow (memoization should help)

### Slow Updates

**Symptoms:** Updates take > 100ms

**Solutions:**
1. Ensure smart diff is working (only changed elements update)
2. Check if SSE updates are too frequent (debounce if needed)
3. Use batch scheduling for multiple updates

### Scrolling Janky

**Symptoms:** Scroll feels stuttery, not 60fps

**Solutions:**
1. Use virtual scrolling for lists > 100 items
2. Throttle scroll event handlers
3. Reduce DOM complexity in list items

### Memory Issues

**Symptoms:** Memory usage grows over time

**Solutions:**
1. Clear memoization caches periodically
2. Use virtual scrolling to limit DOM nodes
3. Call `perfMonitor.clear()` after reporting

## Examples

### Large Timeline

```javascript
// Problem: 1000+ timeline events
const timeline = data.timeline; // 1000 items

// Solution 1: Virtual scrolling
const virtualScroll = new VirtualScroll(container, {
  itemHeight: 80,
  buffer: 10
});
virtualScroll.setItems(timeline);

// Solution 2: Pagination
const PAGE_SIZE = 50;
renderTimelinePage(timeline.slice(0, PAGE_SIZE));
```

### Frequent Updates

```javascript
// Problem: SSE updates every 100ms
eventSource.onmessage = (event) => {
  updateDashboard(JSON.parse(event.data));
};

// Solution: Debounce updates
const debouncedUpdate = debounce(updateDashboard, 250);

eventSource.onmessage = (event) => {
  debouncedUpdate(JSON.parse(event.data));
};
```

### Large Data Processing

```javascript
// Problem: Processing 10,000 records
function processRecords(records) {
  return records.map(expensiveTransform);
}

// Solution: Memoize + incremental
const memoizedTransform = memoize(expensiveTransform);

async function processRecords(records) {
  const renderer = new IncrementalRenderer({
    chunkSize: 100,
    onProgress: (current, total) => {
      showProgress(current / total);
    }
  });
  
  await renderer.render(records, memoizedTransform, container);
}
```

## API Reference

See `web/assets/utils/performance.js` for complete API documentation.






