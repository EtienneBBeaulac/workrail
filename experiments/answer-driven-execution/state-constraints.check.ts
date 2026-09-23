import type {
  SlotState,
  RunningSlotState,
  TerminalSlotState,
  ActiveModelCall,
} from './trial-executor.mjs';
import type {
  CanonicalOverlap,
} from './trial-preflight.mjs';

// Compile-only checks: verify status-discriminated SlotState constraints.

// 1. Valid running state allows activeModelCall (both non-null and null)
const validRunningWithActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'running',
  activeModelCall: { callId: 'call-1', deadlineMs: 4000 },
};

const validRunningWithoutActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'running',
  activeModelCall: null,
};

// 2. Valid terminal states require activeModelCall: null
const validCompleted: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'completed',
  activeModelCall: null,
};

const validFailed: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'failed',
  activeModelCall: null,
};

const validUnknownRemote: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: null,
  modelCallCount: 0,
  status: 'unknown_remote',
  activeModelCall: null,
};

const validConversationReused: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-reused',
  modelCallCount: 0,
  status: 'conversation_reused',
  activeModelCall: null,
};

// 3. Compile-only invalid callers: terminal statuses MUST reject non-null activeModelCall
// @ts-expect-error Terminal state 'completed' must not have non-null activeModelCall
const invalidCompletedActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'completed',
  activeModelCall: { callId: 'call-1', deadlineMs: 4000 },
};

// @ts-expect-error Terminal state 'failed' must not have non-null activeModelCall
const invalidFailedActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 1,
  status: 'failed',
  activeModelCall: { callId: 'call-1', deadlineMs: 4000 },
};

// @ts-expect-error Terminal state 'unknown_remote' must not have non-null activeModelCall
const invalidUnknownRemoteActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: null,
  modelCallCount: 0,
  status: 'unknown_remote',
  activeModelCall: { callId: 'call-1', deadlineMs: 4000 },
};

// @ts-expect-error Terminal state 'conversation_reused' must not have non-null activeModelCall
const invalidConversationReusedActive: SlotState = {
  runId: 'run-1',
  conversationDeadlineMs: 5000,
  currentConversationId: 'conv-1',
  modelCallCount: 0,
  status: 'conversation_reused',
  activeModelCall: { callId: 'call-1', deadlineMs: 4000 },
};

// 4. Natural narrowing on status
declare const slot: SlotState;
if (slot.status === 'running') {
  const _runningSlot: RunningSlotState = slot;
  const _runningCall: ActiveModelCall | null = slot.activeModelCall;
  void [_runningSlot, _runningCall];
} else {
  const _terminalSlot: TerminalSlotState = slot;
  const _terminalCall: null = slot.activeModelCall;
  void [_terminalSlot, _terminalCall];
}

// 5. Compile-only checks: verify CanonicalOverlap discriminated union.
declare const overlap: CanonicalOverlap;
if (overlap.overlaps) {
  const path: string = overlap.canonicalPath;
  void path;
} else {
  // @ts-expect-error canonicalPath is unavailable when overlaps: false
  const invalidPath = overlap.canonicalPath;
  void invalidPath;
}

declare const explicitNoOverlap: Extract<CanonicalOverlap, { readonly overlaps: false }>;
// @ts-expect-error canonicalPath is unavailable on { readonly overlaps: false }
const _badPath = explicitNoOverlap.canonicalPath;
void _badPath;

void [
  validRunningWithActive,
  validRunningWithoutActive,
  validCompleted,
  validFailed,
  validUnknownRemote,
  validConversationReused,
  invalidCompletedActive,
  invalidFailedActive,
  invalidUnknownRemoteActive,
  invalidConversationReusedActive,
];
