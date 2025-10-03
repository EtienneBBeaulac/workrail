import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from '../infrastructure/session/SessionManager.js';
import { HttpServer } from '../infrastructure/session/HttpServer.js';

/**
 * Create MCP tools for session management
 * 
 * These tools allow agents to:
 * - Create new sessions
 * - Update session data
 * - Read session data (with optional JSONPath queries)
 * - Open dashboard in browser
 */
export function createSessionTools(
  sessionManager: SessionManager,
  httpServer: HttpServer
): Tool[] {
  return [
    {
      name: 'workrail_create_session',
      description: `Create a new workflow session stored in ~/.workrail/sessions/.

This creates a JSON file to track all workflow state and data. The dashboard will automatically display this session's progress in real-time.

Returns the session ID and file path.

Example:
  workrail_create_session("bug-investigation", "AUTH-1234", {
    "dashboard": {"title": "Auth bug", "status": "in_progress"}
  })`,
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier (e.g., "bug-investigation", "mr-review")'
          },
          sessionId: {
            type: 'string',
            description: 'Unique session identifier (e.g., ticket ID "AUTH-1234", branch name)'
          },
          initialData: {
            type: 'object',
            description: 'Initial session data (optional). Can include dashboard, phases, etc.',
            default: {}
          }
        },
        required: ['workflowId', 'sessionId']
      }
    },
    
    {
      name: 'workrail_update_session',
      description: `Update session data with deep merge.

Updates are merged into existing data (objects are merged, arrays are replaced).

Use this throughout the workflow to:
- Update progress and confidence
- Add phases and subsections
- Update hypotheses
- Add timeline events
- Update any workflow-specific data

Example:
  workrail_update_session("bug-investigation", "AUTH-1234", {
    "dashboard.progress": 25,
    "dashboard.confidence": 7.5,
    "hypotheses[0].status": "confirmed"
  })

Note: Use dot notation for nested updates. Arrays must be read, modified, then written back completely.`,
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier'
          },
          updates: {
            type: 'object',
            description: 'Data to merge into session. Supports nested updates via dot notation.'
          }
        },
        required: ['workflowId', 'sessionId', 'updates']
      }
    },
    
    {
      name: 'workrail_read_session',
      description: `Read session data with optional JSONPath query for targeted reads.

Reading only what you need saves tokens and improves performance.

Special Queries:
  - Schema overview: workrail_read_session("bug-investigation", "AUTH-1234", "$schema")
    Returns a map of all available fields and common query patterns

Examples:
  - Full session: workrail_read_session("bug-investigation", "AUTH-1234")
  - Dashboard only: workrail_read_session("bug-investigation", "AUTH-1234", "dashboard")
  - Specific hypothesis: workrail_read_session("bug-investigation", "AUTH-1234", "hypotheses[0]")
  - Active hypotheses: workrail_read_session("bug-investigation", "AUTH-1234", "hypotheses[?status=='active']")
  - Phase 1 data: workrail_read_session("bug-investigation", "AUTH-1234", "phases.phase-1")

Supported query syntax:
- Dot notation: "dashboard.confidence"
- Array index: "hypotheses[0]"
- Array filter: "hypotheses[?status=='active']"
- Schema query: "$schema" (returns structure overview)`,
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow identifier'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier'
          },
          path: {
            type: 'string',
            description: 'JSONPath query (optional). If omitted, returns full session data. Examples: "dashboard", "hypotheses[0]", "phases.phase-1.summary"'
          }
        },
        required: ['workflowId', 'sessionId']
      }
    },
    
    {
      name: 'workrail_open_dashboard',
      description: `Open the web dashboard in the user's default browser.

The dashboard shows real-time progress, visualizations, and all session data in a beautiful UI.

If sessionId is provided, opens directly to that session. Otherwise opens to the home page showing all sessions.

The dashboard URL is stable and can be bookmarked or shared.

Example:
  workrail_open_dashboard("AUTH-1234")
  
Returns the dashboard URL.`,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session to display (optional). If provided, dashboard opens directly to this session.'
          }
        }
      }
    }
  ];
}

/**
 * Handle execution of session tools
 */
export async function handleSessionTool(
  name: string,
  args: any,
  sessionManager: SessionManager,
  httpServer: HttpServer
): Promise<any> {
  try {
    switch (name) {
      case 'workrail_create_session': {
        const session = await sessionManager.createSession(
          args.workflowId,
          args.sessionId,
          args.initialData || {}
        );
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              sessionId: session.id,
              workflowId: session.workflowId,
              path: sessionManager.getSessionPath(args.workflowId, args.sessionId),
              dashboardUrl: `${httpServer.getBaseUrl()}?session=${args.sessionId}`,
              message: `Session created: ${args.workflowId}/${args.sessionId}`,
              createdAt: session.createdAt
            }, null, 2)
          }]
        };
      }
      
      case 'workrail_update_session': {
        await sessionManager.updateSession(
          args.workflowId,
          args.sessionId,
          args.updates
        );
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Session updated: ${args.workflowId}/${args.sessionId}`,
              updatedAt: new Date().toISOString()
            }, null, 2)
          }]
        };
      }
      
      case 'workrail_read_session': {
        // Special case: $schema returns structure overview
        if (args.path === '$schema') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                query: '$schema',
                schema: {
                  description: 'Bug Investigation Session Data Structure',
                  mainSections: {
                    dashboard: 'Real-time UI display (progress, confidence, currentPhase, status)',
                    bugSummary: 'Initial bug context (title, description, impact, reproduction)',
                    phases: 'Detailed phase progress (phase-0, phase-1, etc.)',
                    hypotheses: 'Array of investigation theories with status tracking',
                    ruledOut: 'Array of rejected hypotheses',
                    timeline: 'Array of timestamped events',
                    confidenceJourney: 'Array of confidence changes over time',
                    codebaseMap: 'Spatial understanding of components (optional)',
                    rootCause: 'Final diagnosis (set in Phase 6)',
                    fix: 'Proposed solution (set in Phase 6)',
                    recommendations: 'Future prevention steps (set in Phase 6)',
                    metadata: 'Technical details (workflowVersion, projectType, etc.)'
                  },
                  commonQueries: {
                    'dashboard': 'Get all dashboard fields',
                    'dashboard.progress': 'Get just progress percentage',
                    'timeline': 'Get all timeline events',
                    'hypotheses': 'Get all hypotheses',
                    'hypotheses[0]': 'Get first hypothesis',
                    'phases.phase-1': 'Get Phase 1 data',
                    'confidenceJourney': 'Get confidence history'
                  },
                  updatePatterns: {
                    incrementalProgress: 'workrail_update_session(wf, id, {"dashboard.progress": 35, "dashboard.currentPhase": "Phase 2"})',
                    addTimelineEvent: 'Read timeline array, append event, write back',
                    updateConfidence: 'Update both dashboard.confidence AND confidenceJourney array',
                    completePhase: 'Set phases.phase-X.complete = true and add summary'
                  },
                  fullSchemaDoc: 'See docs/dashboard-architecture/bug-investigation-session-schema.md for complete details'
                }
              }, null, 2)
            }]
          };
        }
        
        const data = await sessionManager.readSession(
          args.workflowId,
          args.sessionId,
          args.path
        );
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.path || '(full session)',
              data
            }, null, 2)
          }]
        };
      }
      
      case 'workrail_open_dashboard': {
        const url = await httpServer.openDashboard(args.sessionId);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url,
              message: 'Dashboard opened in browser',
              note: 'If the browser did not open automatically, please open the URL manually.'
            }, null, 2)
          }]
        };
      }
      
      default:
        throw new Error(`Unknown session tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: error.message,
          tool: name,
          suggestion: error.message.includes('not found')
            ? 'Make sure the session exists. Use workrail_create_session() first.'
            : 'Check the error message for details.'
        }, null, 2)
      }],
      isError: true
    };
  }
}

