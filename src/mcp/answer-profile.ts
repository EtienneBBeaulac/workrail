import { RequestLifetime } from './request-lifetime.js';
import { z } from 'zod';
import { createAnswerWorker } from '../answer-v1/worker.js';
import type { SharedAuthorityConfig } from '../answer-v1/contracts/host-composition.js';
import type { ReplyRef, ReadRef, ReceiptRef, EvidenceCursor, RecoveryRef, OpenAttemptRef } from '../answer-v1/contracts/answer-contract.js';
import type { ToolContext } from './types.js';
import type { ComposedServerInternal } from './server.js';
import type { McpCallToolResult } from './types/workflow-tool-edition.js';
import { WorkspaceRootsManager } from './workspace-roots-manager.js';
import { zodToJsonSchema } from './zod-to-json-schema.js';
type AnswerHandler = (args: unknown, ctx: ToolContext, signal?: AbortSignal) => Promise<McpCallToolResult>;
/** Separate composition prevents exposing legacy token-based execution beside answer capabilities. */
export async function composeAnswerProfile(config: SharedAuthorityConfig, ctx: ToolContext): Promise<ComposedServerInternal> {
    const lifetime = new AbortController();
    const runtime = await createAnswerWorker(config, lifetime.signal);
    if (runtime.kind !== 'created')
        throw new Error(`Answer profile unavailable: ${runtime.kind}`);
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const server = new Server({ name: 'workrail-server', version: '0.1.0' }, { capabilities: { tools: {} } });
    const schemas = {
        open_work: z.object({ workflowId: z.string(), workspacePath: z.string(), goal: z.string() }).strict(),
        answer_work: z.object({ reply: z.string(), answer: z.object({ notes: z.string() }).strict() }).strict(),
        inspect_work: z.object({ read: z.string(), receipt: z.string().optional(), cursor: z.string().optional() }).strict(),
        recover_work: z.union([z.object({ recovery: z.string() }).strict(), z.object({ attempt: z.string() }).strict()]),
    };
    const descriptions = { open_work: 'Start a workflow and receive the next question.', answer_work: 'Answer the current question using its reply reference.', inspect_work: 'Read current work or retained evidence without advancing it.', recover_work: 'Resume work from a recovery reference or reconcile an uncertain start.' };
    function handler<S extends z.ZodTypeAny>(schema: S, run: (input: z.output<S>, signal: AbortSignal) => Promise<unknown>): AnswerHandler {
        return async (args, _ctx, requestSignal) => {
            const input = schema.safeParse(args);
            if (!input.success)
                return { isError: true, content: [{ type: 'text', text: JSON.stringify({ kind: 'invalid_input', issues: input.error.issues }) }] };
            const result = await run(input.data, AbortSignal.any([lifetime.signal, requestSignal ?? lifetime.signal]));
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        };
    }
    const handlers: Record<keyof typeof schemas, AnswerHandler> = {
        open_work: handler(schemas.open_work, (input, signal) => runtime.opener.open(input, signal)),
        answer_work: handler(schemas.answer_work, (input, signal) => runtime.worker.answer(input.reply as ReplyRef, { kind: 'notes', notes: input.answer.notes }, signal)),
        inspect_work: handler(schemas.inspect_work, (input, signal) => input.receipt === undefined ? runtime.inspector.inspect(input.read as ReadRef, signal) : runtime.inspector.inspectReceipt(input.read as ReadRef, input.receipt as ReceiptRef, signal, input.cursor as EvidenceCursor | undefined)),
        recover_work: handler(schemas.recover_work, (input, signal) => 'recovery' in input ? runtime.recovery.recover(input.recovery as RecoveryRef, signal) : runtime.recovery.reconcileOpen(input.attempt as OpenAttemptRef, signal)),
    };
    const tools = (Object.keys(schemas) as (keyof typeof schemas)[]).map(name => ({ name, description: descriptions[name], inputSchema: zodToJsonSchema(schemas[name]) }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    const requests = new RequestLifetime();
    server.setRequestHandler(CallToolRequestSchema, requests.wrap( async (request, extra) => {
        const name = request.params.name;
        if (!Object.prototype.hasOwnProperty.call(handlers, name))
            return { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + name }] };
        try {
            // The transport owns cancellation; worker operations also observe runtime shutdown.
            const fn = handlers[name as keyof typeof handlers];
            return await fn(request.params.arguments ?? {}, ctx, extra.signal);
        }
        catch (error) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ kind: 'unavailable', detail: String(error) }) }] };
        }
    }));
    server.onclose = () => { void requests.close(); lifetime.abort(); void runtime.close(new AbortController().signal); };
    const rootsManager = new WorkspaceRootsManager();
    return { closeRequests: () => requests.close(), server, ctx, rootsManager, rootsReader: rootsManager, tools, handlers };
}
