/**
 * AutoView -- the AUTO tab of the WorkRail console.
 *
 * Two-column layout:
 * - 40% DispatchPane (left): workflow selector, goal input, trigger list
 * - 60% QueuePane (right): autonomous session list with status band
 *
 * On mobile (< md breakpoint) the columns stack vertically.
 *
 * Pure presenter: no ViewModel layer for MVP. DispatchPane and QueuePane
 * own their fetch hooks directly. AppShell renders this view unconditionally
 * when activeTab === 'auto'.
 */

import { DispatchPane } from '../components/DispatchPane';
import { QueuePane } from '../components/QueuePane';

export function AutoView() {
  return (
    <div className="flex flex-col md:flex-row gap-6">
      {/* Dispatch pane: 40% on desktop, full-width on mobile */}
      <div className="w-full md:w-2/5 shrink-0">
        <DispatchPane />
      </div>

      {/* Queue pane: 60% on desktop, full-width on mobile */}
      <div className="flex-1 min-w-0">
        <QueuePane />
      </div>
    </div>
  );
}
