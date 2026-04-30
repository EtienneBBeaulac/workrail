/**
 * backlog-priority.ts
 *
 * Reads docs/ideas/backlog.md and prints a sorted, filtered priority view.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --min-score 10
 *   npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --unblocked-only
 *   npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --blocked-only
 *   npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --section daemon
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const minScore = (() => {
  const idx = args.indexOf('--min-score');
  return idx !== -1 ? parseInt(args[idx + 1] ?? '0', 10) : 0;
})();
const unblockedOnly = args.includes('--unblocked-only');
const blockedOnly = args.includes('--blocked-only');
const sectionFilter = (() => {
  const idx = args.indexOf('--section');
  return idx !== -1 ? (args[idx + 1] ?? '').toLowerCase() : null;
})();
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`
Usage: backlog-priority [options]

Options:
  --min-score N      Only show items with score >= N (default: 0)
  --unblocked-only   Only show unblocked items
  --blocked-only     Only show blocked items
  --section NAME     Filter by section name (partial match, case-insensitive)
  --help             Show this help

Examples:
  npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --min-score 11 --unblocked-only
  npx ts-node --project scripts/tsconfig.json scripts/backlog-priority.ts --section daemon
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface BacklogItem {
  title: string;
  section: string;
  status: string;
  score: number;
  cor: number;
  cap: number;
  eff: number;
  lev: number;
  con: number;
  blocked: boolean;
  blockedBy: string;
}

const backlogPath = path.join(__dirname, '..', 'docs', 'ideas', 'backlog.md');
const raw = fs.readFileSync(backlogPath, 'utf-8');
const lines = raw.split('\n');

const items: BacklogItem[] = [];
let currentSection = '';

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Track current top-level section
  if (line.startsWith('## ')) {
    currentSection = line.slice(3).trim();
    continue;
  }

  // Item heading
  if (!line.startsWith('### ')) continue;
  const title = line.slice(4).trim();

  // Look ahead for Status and Score within next 10 lines
  let status = '';
  let score = 0;
  let cor = 0, cap = 0, eff = 0, lev = 0, con = 0;
  let blocked = false;
  let blockedBy = '';

  for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
    const l = lines[j];

    // Skip empty lines and horizontal rules
    if (l.trim() === '' || l.trim() === '---') continue;

    // Stop if we hit another heading
    if (l.startsWith('#')) break;

    if (l.startsWith('**Status:') && !status) {
      const m = l.match(/\*\*Status:\s*([^*|]+)/);
      if (m) status = m[1].trim();
    }

    if (l.startsWith('**Score:') && !score) {
      const scoreMatch = l.match(/\*\*Score:\s*(\d+)\*\*/);
      if (scoreMatch) score = parseInt(scoreMatch[1], 10);

      const corMatch = l.match(/Cor:(\d)/);
      const capMatch = l.match(/Cap:(\d)/);
      const effMatch = l.match(/Eff:(\d)/);
      const levMatch = l.match(/Lev:(\d)/);
      const conMatch = l.match(/Con:(\d)/);
      if (corMatch) cor = parseInt(corMatch[1], 10);
      if (capMatch) cap = parseInt(capMatch[1], 10);
      if (effMatch) eff = parseInt(effMatch[1], 10);
      if (levMatch) lev = parseInt(levMatch[1], 10);
      if (conMatch) con = parseInt(conMatch[1], 10);

      const blockedMatch = l.match(/Blocked:\s*(.+)$/i);
      if (blockedMatch) {
        const b = blockedMatch[1].trim();
        blocked = !b.toLowerCase().startsWith('no');
        blockedBy = blocked ? b.replace(/^yes\s*\(?/i, '').replace(/\)$/, '').trim() : '';
      }
    }
  }

  // Only include items that have a score
  if (!score) continue;

  // Skip done/resolved items
  const statusLower = status.toLowerCase();
  if (statusLower.startsWith('done') || statusLower.startsWith('resolved')) continue;

  items.push({ title, section: currentSection, status, score, cor, cap, eff, lev, con, blocked, blockedBy });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

let filtered = items;

if (minScore > 0) filtered = filtered.filter(i => i.score >= minScore);
if (unblockedOnly) filtered = filtered.filter(i => !i.blocked);
if (blockedOnly) filtered = filtered.filter(i => i.blocked);
if (sectionFilter) filtered = filtered.filter(i => i.section.toLowerCase().includes(sectionFilter));

// Sort: unblocked first, then by score descending
filtered.sort((a, b) => {
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  return b.score - a.score;
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

function scoreColor(score: number): string {
  if (score >= 12) return GREEN;
  if (score >= 10) return CYAN;
  if (score >= 8) return YELLOW;
  return GRAY;
}

const unblocked = filtered.filter(i => !i.blocked);
const blocked = filtered.filter(i => i.blocked);

console.log(`\n${BOLD}Backlog priority view${RESET}  ${DIM}(${filtered.length} items, ${unblocked.length} unblocked)${RESET}`);

const filterParts: string[] = [];
if (minScore > 0) filterParts.push(`min score ${minScore}`);
if (unblockedOnly) filterParts.push('unblocked only');
if (blockedOnly) filterParts.push('blocked only');
if (sectionFilter) filterParts.push(`section: ${sectionFilter}`);
if (filterParts.length > 0) {
  console.log(`${DIM}Filters: ${filterParts.join(', ')}${RESET}`);
}
console.log();

function printItem(item: BacklogItem, rank: number): void {
  const sc = scoreColor(item.score);
  const blockStr = item.blocked
    ? `  ${RED}[blocked: ${item.blockedBy}]${RESET}`
    : '';
  const details = `${DIM}Cor:${item.cor} Cap:${item.cap} Eff:${item.eff} Lev:${item.lev} Con:${item.con}${RESET}`;
  const section = `${DIM}[${item.section}]${RESET}`;
  console.log(
    `  ${DIM}${String(rank).padStart(3)}.${RESET} ${sc}${BOLD}${item.score}${RESET}  ${item.title.slice(0, 70)}${item.title.length > 70 ? '…' : ''}${blockStr}`
  );
  console.log(`       ${details}  ${section}`);
}

if (!blockedOnly && unblocked.length > 0) {
  console.log(`${BOLD}${GREEN}Unblocked (${unblocked.length})${RESET}`);
  unblocked.forEach((item, idx) => printItem(item, idx + 1));
  console.log();
}

if (!unblockedOnly && blocked.length > 0) {
  console.log(`${BOLD}${GRAY}Blocked (${blocked.length})${RESET}`);
  blocked.forEach((item, idx) => printItem(item, idx + 1));
  console.log();
}

// Summary of top 5 unblocked
if (!blockedOnly && !sectionFilter && unblocked.length > 0) {
  console.log(`${BOLD}Top 5 unblocked by score:${RESET}`);
  unblocked.slice(0, 5).forEach((item, idx) => {
    const sc = scoreColor(item.score);
    console.log(`  ${idx + 1}. ${sc}${item.score}${RESET}  ${item.title.slice(0, 80)}`);
  });
  console.log();
}
