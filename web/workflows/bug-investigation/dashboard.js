// Bug Investigation Dashboard JavaScript
// Handles real-time updates and visualization

const API_BASE = window.location.origin;
let confidenceChart = null;
let currentSessionData = null;
let refreshInterval = null;

// Extract session info from URL
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session');
const workflowId = urlParams.get('workflow') || 'bug-investigation'; // Support both short and full workflow IDs

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    if (!sessionId) {
        showError('No session ID provided');
        return;
    }

    document.getElementById('sessionId').textContent = sessionId;
    initializeConfidenceChart();
    loadSessionData();

    // Auto-refresh every 3 seconds
    refreshInterval = setInterval(loadSessionData, 3000);
});

// Load session data from API
async function loadSessionData() {
    try {
        const response = await fetch(`${API_BASE}/api/sessions/${workflowId}/${sessionId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const result = await response.json();
        // API returns { success: true, session: { data: {...} } }
        currentSessionData = result.session?.data || result.data;
        
        updateDashboard(currentSessionData);
        document.getElementById('lastUpdate').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        console.error('Error loading session data:', error);
        showError(`Failed to load session: ${error.message}`);
    }
}

// Update all dashboard components
function updateDashboard(session) {
    if (!session) return;

    updateStatusBar(session.dashboard || {});
    updateProgress(session.dashboard || {});
    updateBugSummary(session.bugSummary || {});
    updatePhases(session.phases || {});
    updateTopSuspects(session.dashboard || {});
    updateHypotheses(session.hypotheses || []);
    updateRuledOut(session.ruledOut || []);
    updateTimeline(session.timeline || []);
    updateConfidenceJourney(session.confidenceJourney || []);
    updateRootCause(session.rootCause);
    updateFix(session.fix);
}

// Update status bar
function updateStatusBar(dashboard) {
    const status = dashboard.status || 'in_progress';
    const statusEl = document.getElementById('status');
    statusEl.textContent = status.replace('_', ' ').toUpperCase();
    statusEl.className = `status-value badge badge-${status}`;

    document.getElementById('progress').textContent = `${dashboard.progress || 0}%`;
    
    const confidence = dashboard.confidence || 0;
    const confidenceEl = document.getElementById('confidence');
    confidenceEl.textContent = `${confidence.toFixed(1)}/10`;
    confidenceEl.className = `status-value confidence-${getConfidenceLevel(confidence)}`;

    document.getElementById('currentPhase').textContent = dashboard.currentPhase || '--';
    
    if (dashboard.startedAt) {
        const duration = calculateDuration(dashboard.startedAt, dashboard.completedAt);
        document.getElementById('duration').textContent = duration;
    }
}

// Update progress circle
function updateProgress(dashboard) {
    const progress = dashboard.progress || 0;
    const circle = document.getElementById('progressCircle');
    const text = document.getElementById('progressText');
    const step = document.getElementById('currentStep');

    // Update circle (502.4 = 2 * PI * 80)
    const circumference = 502.4;
    const offset = circumference - (progress / 100) * circumference;
    circle.style.strokeDasharray = circumference;
    circle.style.strokeDashoffset = offset;

    // Update color based on progress
    if (progress < 30) {
        circle.style.stroke = '#FF9800'; // Orange
    } else if (progress < 70) {
        circle.style.stroke = '#2196F3'; // Blue
    } else {
        circle.style.stroke = '#4CAF50'; // Green
    }

    text.textContent = `${progress}%`;
    step.textContent = dashboard.currentStep || 'Initializing...';
}

// Update bug summary
function updateBugSummary(bugSummary) {
    const container = document.getElementById('bugSummary');
    if (!bugSummary.description) {
        container.innerHTML = '<p class="empty-state">No bug summary available</p>';
        return;
    }

    container.innerHTML = `
        <div class="summary-item">
            <strong>Description:</strong>
            <p>${escapeHtml(bugSummary.description)}</p>
        </div>
        <div class="summary-row">
            <div class="summary-item">
                <strong>Impact:</strong>
                <span class="badge badge-${bugSummary.impact?.toLowerCase() || 'medium'}">${bugSummary.impact || 'Unknown'}</span>
            </div>
            <div class="summary-item">
                <strong>Frequency:</strong>
                <span>${escapeHtml(bugSummary.frequency || 'Unknown')}</span>
            </div>
        </div>
        <div class="summary-item">
            <strong>Environment:</strong>
            <span>${escapeHtml(bugSummary.environment || 'Unknown')}</span>
        </div>
        ${bugSummary.reproduction ? `
        <div class="summary-item">
            <strong>Reproduction Steps:</strong>
            <pre>${escapeHtml(bugSummary.reproduction)}</pre>
        </div>
        ` : ''}
    `;
}

// Update phases
function updatePhases(phases) {
    const container = document.getElementById('phaseList');
    const phaseOrder = ['phase-0', 'phase-1', 'phase-2', 'phase-2g', 'phase-3', 'phase-4', 'phase-5', 'phase-6'];
    const phaseNames = {
        'phase-0': 'Phase 0: Triage & Setup',
        'phase-1': 'Phase 1: Analysis',
        'phase-2': 'Phase 2: Hypotheses',
        'phase-2g': 'Phase 2g: Instrumentation Plan',
        'phase-3': 'Phase 3: Instrumentation',
        'phase-4': 'Phase 4: Evidence Collection',
        'phase-5': 'Phase 5: Analysis',
        'phase-6': 'Phase 6: Final Report'
    };

    let html = '';
    phaseOrder.forEach(phaseId => {
        const phase = phases[phaseId] || {};
        const isComplete = phase.complete === true;
        const icon = isComplete ? '✅' : '⏳';
        
        html += `
            <div class="phase-item ${isComplete ? 'complete' : 'pending'}">
                <div class="phase-header">
                    <span class="phase-icon">${icon}</span>
                    <span class="phase-name">${phaseNames[phaseId]}</span>
                </div>
                ${phase.summary ? `<div class="phase-summary">${escapeHtml(phase.summary)}</div>` : ''}
            </div>
        `;
    });

    container.innerHTML = html || '<p class="empty-state">No phase data yet</p>';
}

// Update top suspects
function updateTopSuspects(dashboard) {
    const container = document.getElementById('topSuspects');
    const suspects = dashboard.topSuspects || [];
    
    if (suspects.length === 0) {
        container.innerHTML = '<p class="empty-state">Analysis in progress...</p>';
        return;
    }

    let html = suspects.map((suspect, index) => `
        <div class="suspect-item">
            <div class="suspect-rank">#${index + 1}</div>
            <div class="suspect-name">${escapeHtml(suspect)}</div>
        </div>
    `).join('');

    if (dashboard.topSuspectsReasoning) {
        html += `<div class="suspects-reasoning">${escapeHtml(dashboard.topSuspectsReasoning)}</div>`;
    }

    container.innerHTML = html;
}

// Update hypotheses
function updateHypotheses(hypotheses) {
    const container = document.getElementById('hypothesesList');
    
    if (hypotheses.length === 0) {
        container.innerHTML = '<p class="empty-state">Hypotheses will be generated after analysis...</p>';
        return;
    }

    const html = hypotheses.map(h => `
        <div class="hypothesis-item status-${h.status || 'pending'}">
            <div class="hypothesis-header">
                <span class="hypothesis-id">${escapeHtml(h.id)}</span>
                <span class="hypothesis-status badge badge-${h.status || 'pending'}">${h.status || 'pending'}</span>
            </div>
            <div class="hypothesis-title">${escapeHtml(h.title || h.description)}</div>
            ${h.likelihood ? `<div class="hypothesis-likelihood">Likelihood: ${h.likelihood}/10</div>` : ''}
            ${h.confidence ? `<div class="hypothesis-confidence">Confidence: ${h.confidence}/10</div>` : ''}
            ${h.evidence && h.evidence.length > 0 ? `
                <div class="hypothesis-evidence">
                    <strong>Evidence (${h.evidence.length}):</strong>
                    ${h.evidence.slice(0, 3).map(e => `
                        <div class="evidence-item">
                            <span class="evidence-strength badge-${e.strength}">${e.strength}</span>
                            ${escapeHtml(e.description)}
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </div>
    `).join('');

    container.innerHTML = html;
}

// Update ruled out
function updateRuledOut(ruledOut) {
    const container = document.getElementById('ruledOutList');
    
    if (ruledOut.length === 0) {
        container.innerHTML = '<p class="empty-state">No hypotheses ruled out yet...</p>';
        return;
    }

    const html = ruledOut.map(item => `
        <div class="ruled-out-item">
            <div class="ruled-out-header">
                <span class="ruled-out-icon">❌</span>
                <span class="ruled-out-item-name">${escapeHtml(item.item)}</span>
            </div>
            <div class="ruled-out-reason">${escapeHtml(item.reason)}</div>
            <div class="ruled-out-timestamp">${new Date(item.timestamp).toLocaleString()}</div>
        </div>
    `).join('');

    container.innerHTML = html;
}

// Update timeline
function updateTimeline(timeline) {
    const container = document.getElementById('timeline');
    
    if (timeline.length === 0) {
        container.innerHTML = '<p class="empty-state">Timeline will appear as investigation progresses...</p>';
        return;
    }

    // Show last 20 events, most recent first
    const recentEvents = timeline.slice(-20).reverse();
    
    const html = recentEvents.map(event => {
        const typeClass = event.type || 'default';
        const icon = getEventIcon(event.type);
        
        return `
            <div class="timeline-event type-${typeClass}">
                <div class="timeline-time">${new Date(event.timestamp).toLocaleTimeString()}</div>
                <div class="timeline-marker">${icon}</div>
                <div class="timeline-content">
                    <div class="timeline-phase">Phase ${event.phase}</div>
                    <div class="timeline-event-text">${escapeHtml(event.event)}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

// Update confidence journey chart
function updateConfidenceJourney(journey) {
    if (!confidenceChart) return;

    const labels = journey.map(j => `Phase ${j.phase}`);
    const data = journey.map(j => j.confidence);

    confidenceChart.data.labels = labels;
    confidenceChart.data.datasets[0].data = data;
    confidenceChart.update('none'); // No animation for real-time updates
}

// Update root cause (when found)
function updateRootCause(rootCause) {
    const card = document.getElementById('rootCauseCard');
    const container = document.getElementById('rootCause');
    
    if (!rootCause || !rootCause.identified) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    container.innerHTML = `
        <div class="root-cause-confidence">
            <strong>Confidence:</strong> 
            <span class="confidence-${getConfidenceLevel(rootCause.confidence)}">${rootCause.confidence}/10</span>
        </div>
        <div class="root-cause-description">
            <strong>Description:</strong>
            <p>${escapeHtml(rootCause.description)}</p>
        </div>
        <div class="root-cause-location">
            <strong>Location:</strong>
            <code>${escapeHtml(rootCause.location)}</code>
        </div>
        <div class="root-cause-mechanism">
            <strong>Mechanism:</strong>
            <p>${escapeHtml(rootCause.mechanism)}</p>
        </div>
    `;
}

// Update fix recommendation
function updateFix(fix) {
    const card = document.getElementById('fixCard');
    const container = document.getElementById('fix');
    
    if (!fix || !fix.approach) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    container.innerHTML = `
        <div class="fix-approach">
            <strong>Approach:</strong>
            <p>${escapeHtml(fix.approach)}</p>
        </div>
        ${fix.filesAffected && fix.filesAffected.length > 0 ? `
        <div class="fix-files">
            <strong>Files Affected:</strong>
            <ul>
                ${fix.filesAffected.map(file => `<li><code>${escapeHtml(file)}</code></li>`).join('')}
            </ul>
        </div>
        ` : ''}
        ${fix.risks && fix.risks.length > 0 ? `
        <div class="fix-risks">
            <strong>Risks:</strong>
            <ul>
                ${fix.risks.map(risk => `<li>${escapeHtml(risk)}</li>`).join('')}
            </ul>
        </div>
        ` : ''}
        ${fix.testingStrategy ? `
        <div class="fix-testing">
            <strong>Testing Strategy:</strong>
            <p>${escapeHtml(fix.testingStrategy)}</p>
        </div>
        ` : ''}
    `;
}

// Initialize confidence chart
function initializeConfidenceChart() {
    const ctx = document.getElementById('confidenceChart').getContext('2d');
    confidenceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Confidence Level',
                data: [],
                borderColor: '#2196F3',
                backgroundColor: 'rgba(33, 150, 243, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 10,
                    ticks: {
                        stepSize: 2
                    }
                }
            }
        }
    });
}

// Utility functions
function getConfidenceLevel(confidence) {
    if (confidence < 4) return 'low';
    if (confidence < 7) return 'medium';
    return 'high';
}

function getEventIcon(type) {
    const icons = {
        'phase_start': '▶️',
        'phase_complete': '✅',
        'hypothesis_created': '💡',
        'hypothesis_confirmed': '✅',
        'hypothesis_rejected': '❌',
        'finding': '🔍',
        'milestone': '⭐',
        'investigation_complete': '🎉'
    };
    return icons[type] || '📌';
}

function calculateDuration(start, end) {
    const startTime = new Date(start);
    const endTime = end ? new Date(end) : new Date();
    const diff = endTime - startTime;
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showError(message) {
    document.body.innerHTML = `
        <div style="text-align: center; padding: 50px;">
            <h1>❌ Error</h1>
            <p>${escapeHtml(message)}</p>
            <a href="/">Back to Home</a>
        </div>
    `;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
});

