/**
 * DashboardWriter
 * 
 * Helper class for building dashboard-ready session data with a fluent API.
 * Simplifies creating well-structured data for the Generic Dashboard.
 * 
 * @example
 * ```typescript
 * const dashboard = new DashboardWriter('bug-investigation', 'BUG-123')
 *   .setTitle('Bug Investigation')
 *   .setStatus('in_progress')
 *   .setProgress(45)
 *   .addSection('summary', { description: '...', severity: 'high' })
 *   .addTimeline({ event: 'Started', timestamp: new Date().toISOString() })
 *   .setOrder(['summary', 'timeline'])
 *   .makeCollapsible('timeline');
 * 
 * await dashboard.save();
 * ```
 */

export interface DashboardMeta {
  order?: string[];
  hidden?: string[];
  icons?: Record<string, string>;
  collapsible?: Record<string, boolean>;
}

export interface DashboardData {
  title?: string;
  subtitle?: string;
  status?: 'pending' | 'in_progress' | 'complete' | 'error' | 'cancelled';
  progress?: number;
  confidence?: number;
  currentPhase?: string;
  _meta?: DashboardMeta;
}

export interface SessionData {
  dashboard?: DashboardData;
  [key: string]: any;
}

export class DashboardWriter {
  private data: SessionData = {
    dashboard: {}
  };
  
  constructor(
    private workflowId: string,
    private sessionId: string
  ) {}
  
  // ==================== Dashboard Configuration ====================
  
  /**
   * Set dashboard title
   */
  setTitle(title: string): this {
    this.ensureDashboard();
    this.data.dashboard!.title = title;
    return this;
  }
  
  /**
   * Set dashboard subtitle
   */
  setSubtitle(subtitle: string): this {
    this.ensureDashboard();
    this.data.dashboard!.subtitle = subtitle;
    return this;
  }
  
  /**
   * Set workflow status
   */
  setStatus(status: DashboardData['status']): this {
    this.ensureDashboard();
    this.data.dashboard!.status = status;
    return this;
  }
  
  /**
   * Set progress (0-100)
   */
  setProgress(progress: number): this {
    this.ensureDashboard();
    this.data.dashboard!.progress = Math.max(0, Math.min(100, progress));
    return this;
  }
  
  /**
   * Set confidence score (0-10)
   */
  setConfidence(confidence: number): this {
    this.ensureDashboard();
    this.data.dashboard!.confidence = Math.max(0, Math.min(10, confidence));
    return this;
  }
  
  /**
   * Set current phase
   */
  setCurrentPhase(phase: string): this {
    this.ensureDashboard();
    this.data.dashboard!.currentPhase = phase;
    return this;
  }
  
  // ==================== Meta Configuration ====================
  
  /**
   * Set section order
   */
  setOrder(order: string[]): this {
    this.ensureMeta();
    this.data.dashboard!._meta!.order = order;
    return this;
  }
  
  /**
   * Add field to section order
   */
  addToOrder(field: string): this {
    this.ensureMeta();
    if (!this.data.dashboard!._meta!.order) {
      this.data.dashboard!._meta!.order = [];
    }
    this.data.dashboard!._meta!.order.push(field);
    return this;
  }
  
  /**
   * Hide fields from dashboard
   */
  hide(...fields: string[]): this {
    this.ensureMeta();
    if (!this.data.dashboard!._meta!.hidden) {
      this.data.dashboard!._meta!.hidden = [];
    }
    this.data.dashboard!._meta!.hidden.push(...fields);
    return this;
  }
  
  /**
   * Set icon for a field
   */
  setIcon(field: string, icon: string): this {
    this.ensureMeta();
    if (!this.data.dashboard!._meta!.icons) {
      this.data.dashboard!._meta!.icons = {};
    }
    this.data.dashboard!._meta!.icons[field] = icon;
    return this;
  }
  
  /**
   * Make a section collapsible
   */
  makeCollapsible(field: string, collapsible = true): this {
    this.ensureMeta();
    if (!this.data.dashboard!._meta!.collapsible) {
      this.data.dashboard!._meta!.collapsible = {};
    }
    this.data.dashboard!._meta!.collapsible[field] = collapsible;
    return this;
  }
  
  // ==================== Data Sections ====================
  
  /**
   * Add or update a section
   */
  addSection(name: string, data: any): this {
    this.data[name] = data;
    return this;
  }
  
  /**
   * Update an existing section (shallow merge)
   */
  updateSection(name: string, updates: any): this {
    if (!this.data[name]) {
      this.data[name] = {};
    }
    this.data[name] = { ...this.data[name], ...updates };
    return this;
  }
  
  /**
   * Remove a section
   */
  removeSection(name: string): this {
    delete this.data[name];
    return this;
  }
  
  // ==================== Specialized Section Builders ====================
  
  /**
   * Add a timeline event
   */
  addTimeline(event: { event: string; timestamp?: string; details?: string; [key: string]: any }): this {
    if (!this.data.timeline) {
      this.data.timeline = [];
    }
    
    if (!Array.isArray(this.data.timeline)) {
      throw new Error('Timeline must be an array');
    }
    
    // Auto-add timestamp if not provided
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }
    
    this.data.timeline.push(event);
    return this;
  }
  
  /**
   * Add a hypothesis
   */
  addHypothesis(hypothesis: {
    hypothesis: string;
    status: 'active' | 'testing' | 'confirmed' | 'partial' | 'rejected' | 'cancelled';
    confidence?: number;
    reasoning?: string;
    [key: string]: any;
  }): this {
    if (!this.data.hypotheses) {
      this.data.hypotheses = [];
    }
    
    if (!Array.isArray(this.data.hypotheses)) {
      throw new Error('Hypotheses must be an array');
    }
    
    this.data.hypotheses.push(hypothesis);
    return this;
  }
  
  /**
   * Add a recommendation
   */
  addRecommendation(recommendation: {
    description: string;
    priority: number;
    reasoning?: string;
    effort?: string;
    status?: string;
    [key: string]: any;
  }): this {
    if (!this.data.recommendations) {
      this.data.recommendations = [];
    }
    
    if (!Array.isArray(this.data.recommendations)) {
      throw new Error('Recommendations must be an array');
    }
    
    this.data.recommendations.push(recommendation);
    return this;
  }
  
  /**
   * Add a finding/issue
   */
  addFinding(finding: {
    finding?: string;
    description?: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    file?: string;
    line?: number;
    [key: string]: any;
  }): this {
    if (!this.data.findings) {
      this.data.findings = [];
    }
    
    if (!Array.isArray(this.data.findings)) {
      throw new Error('Findings must be an array');
    }
    
    this.data.findings.push(finding);
    return this;
  }
  
  /**
   * Add or update a phase
   */
  addPhase(phaseId: string, phase: {
    name: string;
    complete: boolean;
    summary?: string;
    details?: any;
    [key: string]: any;
  }): this {
    if (!this.data.phases) {
      this.data.phases = {};
    }
    
    if (Array.isArray(this.data.phases)) {
      throw new Error('Phases must be an object, not an array');
    }
    
    this.data.phases[phaseId] = phase;
    return this;
  }
  
  /**
   * Mark a phase as complete
   */
  completePhase(phaseId: string): this {
    if (!this.data.phases || !this.data.phases[phaseId]) {
      throw new Error(`Phase ${phaseId} does not exist`);
    }
    
    this.data.phases[phaseId].complete = true;
    return this;
  }
  
  // ==================== Helpers ====================
  
  /**
   * Get the current session data
   */
  getData(): SessionData {
    return JSON.parse(JSON.stringify(this.data));
  }
  
  /**
   * Get JSON string
   */
  toJSON(): string {
    return JSON.stringify(this.data, null, 2);
  }
  
  /**
   * Save to session (requires MCP context)
   * Note: This is a placeholder - actual implementation depends on your MCP setup
   * 
   * TODO: Implement via MCP session tools when available:
   *   workrail_update_session(this.workflowId, this.sessionId, this.toJSON())
   */
  async save(): Promise<void> {
    throw new Error(
      'DashboardWriter.save() not implemented. ' +
      'Use toUpdates() and call workrail_update_session() directly.'
    );
  }
  
  /**
   * Create updates object for incremental updates
   * (for use with workrail_update_session)
   */
  toUpdates(): Record<string, any> {
    return this.data;
  }
  
  // ==================== Private Helpers ====================
  
  private ensureDashboard(): void {
    if (!this.data.dashboard) {
      this.data.dashboard = {};
    }
  }
  
  private ensureMeta(): void {
    this.ensureDashboard();
    if (!this.data.dashboard!._meta) {
      this.data.dashboard!._meta = {};
    }
  }
  
  // ==================== Static Factory Methods ====================
  
  /**
   * Create a DashboardWriter for a bug investigation workflow
   */
  static bugInvestigation(sessionId: string): DashboardWriter {
    return new DashboardWriter('bug-investigation', sessionId)
      .setOrder(['bugSummary', 'rootCause', 'fix', 'hypotheses', 'timeline', 'recommendations'])
      .setIcon('bugSummary', 'bug')
      .setIcon('rootCause', 'alert-circle')
      .setIcon('fix', 'wrench')
      .setIcon('hypotheses', 'lightbulb')
      .setIcon('timeline', 'clock')
      .setIcon('recommendations', 'star')
      .makeCollapsible('timeline')
      .makeCollapsible('hypotheses');
  }
  
  /**
   * Create a DashboardWriter for a code review workflow
   */
  static codeReview(sessionId: string): DashboardWriter {
    return new DashboardWriter('code-review', sessionId)
      .setOrder(['summary', 'findings', 'recommendations'])
      .setIcon('summary', 'file-text')
      .setIcon('findings', 'alert-circle')
      .setIcon('recommendations', 'star')
      .makeCollapsible('findings');
  }
  
  /**
   * Create a DashboardWriter for a test results workflow
   */
  static testResults(sessionId: string): DashboardWriter {
    return new DashboardWriter('test-results', sessionId)
      .setOrder(['summary', 'results', 'failures'])
      .setIcon('summary', 'bar-chart')
      .setIcon('results', 'check-circle')
      .setIcon('failures', 'x-circle')
      .makeCollapsible('failures');
  }
}






