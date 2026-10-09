import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { V2StartWorkflowInput } from '../../src/mcp/v2/tools.js';
import { ModelRequestSchema, resolveModelSelection } from '../../src/v2/durable-core/domain/model-selection.js';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

// A dedicated normative section prevents a keyword elsewhere in the document
// from satisfying a missing explanation. Relationships remain prose checks:
// they are a regression guard, not a semantic evaluator of arbitrary English.
function modelSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => /^#{2,4} Model selection\b/i.test(line));
  expect(start, 'Document needs a dedicated Model selection section').toBeGreaterThanOrEqual(0);
  const depth = lines[start]!.match(/^#+/)![0].length;
  const next = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${depth}} `).test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n');
}

// Each contract names an actionable relationship. Extra vocabulary, a glossary,
// or an unrelated mention of "client" cannot satisfy these statements.
const explanationContracts = [
  ['resource preference without a capability guarantee', /(?:tier|modelTier)[^.\n]*resource preference[^.\n]*(?:not|does not)[^.\n]*capability guarantee/i],
  ['caller supplies immutable run-scoped bindings', /modelRouting(?=[^.\n]*(?:caller|operator))(?=[^.\n]*(?:suppl|provid))(?=[^.\n]*(?:run-scoped|per-run|this run))[^.\n]*/i],
  ['routing never writes global client configuration', /(?:must not|never|does not)[^.\n]*(?:write|modify|mutate)[^.\n]*global[^.\n]*(?:configuration|settings)/i],
  ['availability checked before launching and again after recovery', /(?:check|verify|revalidate)[^.\n]*availability[^.\n]*before[^.\n]*(?:spawn|launch)[^.\n]*(?:again|recheck)[^.\n]*(?:recover|resum)/i],
  ['unsupported main-agent switching is surfaced', /(?:main.agent|current agent)[^.\n]*(?:cannot|does not support)[^.\n]*switch[^.\n]*(?:unsupported|report|surface)/i],
  ['request or binding is not reported actual execution', /(?:request|binding|resolved target)[^.\n]*(?:is not|does not prove)[^.\n]*(?:actual|executed|ran|execution evidence)/i],
  ['actual identity requires runtime evidence', /(?:actual|reported)[^.\n]*model[^.\n]*(?:only|requires)[^.\n]*(?:runtime|host)[^.\n]*evidence/i],
  ['child request inspected before launch', /initialModelRequest[^.\n]*inspect_workflow[^.\n]*before[^.\n]*(?:spawn|launch)/i],
  ['child receives bindings without parent override', /modelRouting[^.\n]*child[^.\n]*(?:without|do not)[^.\n]*(?:parent|modelTier)/i],
] as const;

describe('explanation measurement controls', () => {
  const complete = [
    'A tier is a resource preference, not a capability guarantee.',
    'modelRouting is operator supplied and run-scoped.',
    'Routing must not modify global client configuration.',
    'Verify availability before spawning and again after recovery.',
    'The main agent cannot switch in place; report unsupported switching.',
    'A request is not actual execution evidence.',
    'The reported model requires runtime evidence.',
    'Resolve initialModelRequest from inspect_workflow before launching.',
    'Pass modelRouting to the child without the parent modelTier override.',
  ];
  it.each(explanationContracts)('accepts the complete explanation for %s', (_name, contract) => {
    expect(complete.join(' ')).toMatch(contract);
  });
  it.each(explanationContracts)('rejects vocabulary without the relationship for %s', (_name, contract) => {
    expect('modelRouting initialModelRequest client operator run-scoped resource preference capability guarantee global configuration availability main agent runtime evidence inspect_workflow child parent modelTier').not.toMatch(contract);
  });
  it.each(explanationContracts)('detects a removed obligation for %s', (_name, contract) => {
    const matching = complete.findIndex(statement => contract.test(statement));
    expect(matching).toBeGreaterThanOrEqual(0);
    expect(complete.filter((_, index) => index !== matching).join(' ')).not.toMatch(contract);
  });
});

const documents = [
  'docs/authoring-v2.md',
  'docs/configuration.md',
  'assets/agent-configs/firebender/workrail-executor.md',
] as const;

describe.each(documents)('%s normative model selection guidance', path => {
  it.each(explanationContracts)('explains %s', (_name, contract) => {
    // Join soft-wrapped paragraphs, while keeping distinct statements separate.
    const section = modelSection(read(path)).replace(/(?<!\n)\n(?!\n)/g, ' ');
    expect(section).toMatch(contract);
  });
});

it('authoring rule cites the implementing domain boundary and client-routing obligations', () => {
  const spec = JSON.parse(read('spec/authoring-spec.json'));
  const rule = spec.topics.flatMap((topic: { rules: { id: string; sourceRefs: { path: string }[]; checks: string[] }[] }) => topic.rules)
    .find((candidate: { id: string }) => candidate.id === 'workflow-model-tier');
  expect(rule).toBeDefined();
  expect(rule.sourceRefs.map((ref: { path: string }) => ref.path)).toContain('src/v2/durable-core/domain/model-selection.ts');
  const obligations = rule.checks.join(' ');
  expect(obligations).toMatch(/modelRouting/);
  expect(obligations).toMatch(/initialModelRequest/);
  expect(obligations).toMatch(/(?:not|never)[^.]*actual|(?:runtime|host)[^.]*evidence/i);
});

it('Codex operator example executes public start schema and initial request resolution', () => {
  const section = modelSection(read('docs/configuration.md'));
  const codex = section.match(/#{3,5} Codex operator example[^\n]*\n([\s\S]*)/i)?.[1];
  expect(codex, 'Configuration needs a Codex operator example').toBeDefined();
  const examples = [...codex!.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
  // These are real API arguments/response fragments, not a separate test DSL.
  const start = examples.find(example => example.workflowId && example.modelRouting && example.workspacePath);
  const inspection = examples.find(example => example.initialModelRequest);
  expect(start, 'Example must show start_workflow arguments with operator-supplied modelRouting').toBeDefined();
  expect(inspection, 'Example must show inspect_workflow initialModelRequest').toBeDefined();
  const parsedStart = V2StartWorkflowInput.parse(start);
  const request = ModelRequestSchema.parse(inspection.initialModelRequest);
  expect(request.kind).toBe('tier');
  const selection = resolveModelSelection(request, parsedStart.modelRouting);
  expect(selection.kind).toBe('resolved');
  if (selection.kind !== 'resolved') return;
  expect(selection.target.kind).toBe('model');
  if (selection.target.kind !== 'model') return;
  expect(selection.target.modelId.length).toBeGreaterThan(0);
  expect(resolveModelSelection(request, {}).kind).toBe('unresolved');
  expect(codex).toMatch(/operator[^.\n]*(?:provide|suppl|choose|confirm)[^.\n]*model/i);
});
