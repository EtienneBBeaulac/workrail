/**
 * Workspace Roots Manager
 *
 * Manages the MCP client's reported workspace root URIs.
 *
 * Interface segregation: RootsReader and RootsWriter are separate so handlers
 * can only read (no mutation surface), while the MCP notification handler holds
 * the RootsWriter.
 *
 * Confinement: the single mutable cell is replaced atomically and written only
 * by the MCP notification handler (Node.js event loop, single-writer guarantee).
 */

/**
 * Read-only view of the current workspace root URIs.
 * Passed into V2Dependencies — handlers receive this interface, never the writer.
 */
export interface RootsReader {
  getCurrentRootUris(): readonly string[];
}

/**
 * Write capability for updating root URIs.
 * Only the MCP roots notification handler should hold a reference to this.
 */
export interface RootsWriter {
  updateRootUris(uris: readonly string[]): void;
}

/**
 * Minimal mutable cell implementing both interfaces.
 *
 * Callers that need to publish roots get RootsWriter.
 * Callers that need to read roots get RootsReader.
 * Neither leaks the other's capability.
 */
export class WorkspaceRootsManager implements RootsReader, RootsWriter {
  private rootUris: readonly string[] = Object.freeze([]);

  updateRootUris(uris: readonly string[]): void {
    // Replace atomically with a frozen snapshot — readers always see a consistent slice.
    this.rootUris = Object.freeze([...uris]);
  }

  getCurrentRootUris(): readonly string[] {
    return this.rootUris;
  }
}
