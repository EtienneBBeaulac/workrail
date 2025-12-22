export interface DataDirPortV2 {
  pinnedWorkflowsDir(): string;
  pinnedWorkflowPath(workflowHash: string): string;
}
