/**
 * ========================================
 * WORKRAIL COMPONENTS v2.0
 * ========================================
 * 
 * Modern Web Components using ES Modules
 * 
 * Usage:
 *   <script type="module">
 *     import '/assets/components/index.js';
 *     // Components automatically registered
 *   </script>
 * 
 * Or selective import:
 *   <script type="module">
 *     import { Card, Button } from '/assets/components/index.js';
 *   </script>
 */

// Base utilities
export { WorkrailComponent, PropTypes, validateProps, h } from './base.js';

// Layout components
export { DashboardLayout } from './DashboardLayout.js';
export { Grid } from './Grid.js';
export { Stack } from './Stack.js';

// UI components
export { Card } from './Card.js';
export { Button } from './Button.js';
export { Badge } from './Badge.js';
export { StatCard } from './StatCard.js';
export { ProgressRing } from './ProgressRing.js';

// Theme management (import existing system)
import '/assets/theme-manager.js';
import '/assets/theme-toggle.js';

console.log('%c🚀 Workrail Components v2.0 loaded', 'color: #8b5cf6; font-weight: bold;');

