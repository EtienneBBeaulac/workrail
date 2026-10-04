import { it } from 'vitest';
import { retainsRejectedNotes, replaysCommittedNotes, refusesInvalidNotesCapabilities } from '../../../experiments/answer-driven-execution/notes-acceptance-cases.js';

it('notes acceptance retains rejected payload and correction authority across MCP restart', retainsRejectedNotes);
it('replays a committed answer without consuming the next assignment or granting read-side write authority', replaysCommittedNotes);
it('refuses wrong-operation and corrupted capabilities without consuming a valid reply', refusesInvalidNotesCapabilities);
