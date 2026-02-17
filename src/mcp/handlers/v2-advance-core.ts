/**
 * v2 Advance Core - Barrel file
 * 
 * Re-exports the public API from the modular implementation.
 */

export type { AdvanceMode, AdvanceCorePorts, AdvanceContext, ComputedAdvanceResults } from './v2-advance-core/index.js';
export type { ValidatedAdvanceInputs } from './v2-advance-core/input-validation.js';
export { executeAdvanceCore } from './v2-advance-core/index.js';
