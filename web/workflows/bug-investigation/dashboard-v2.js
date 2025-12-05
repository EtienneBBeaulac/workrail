// Bug Investigation Dashboard V2 - Real-Time with SSE
// Professional-grade real-time updates with smart diffing and state preservation

const API_BASE = window.location.origin;
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session');
const workflowId = urlParams.get('workflow') || 'bug-investigation';

let currentSessionData = null;
let currentSessionJSON = null; // For change detection
let eventSource = null;
let pollFallbackInterval = null;
let confidenceChart = null;

// UI State (preserved across updates)
const uiState = {
  expandedCards: new Set(['bug-summary-card', 'hypotheses-card', 'top-suspects-card', 'confidence-card']),
  lastUpdated: null
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  if (!sessionId) {
    showError('No session ID provided');
    return;
  }

  document.getElementById('sessionBadge').textContent = sessionId;
  
  // Try SSE first, fall back to polling
  connectSSE();
});

// ============================================
// SSE CONNECTION
// ============================================

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  const sseUrl = `${API_BASE}/api/sessions/${workflowId}/${sessionId}/stream`;
  
  try {
    eventSource = new EventSource(sseUrl);
    
    eventSource.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      
      if (message.type === 'connected') {
        console.log('✅ SSE Connected');
        // Clear any polling fallback
        if (pollFallbackInterval) {
          clearInterval(pollFallbackInterval);
          pollFallbackInterval = null;
        }
      } else if (message.type === 'update') {
        handleSessionUpdate(message.session);
      }
    });
    
    eventSource.addEventListener('error', (error) => {
      console.error('❌ SSE Error, falling back to polling', error);
      eventSource.close();
      eventSource = null;
      
      // Fall back to polling
      if (!pollFallbackInterval) {
        pollFallbackInterval = setInterval(loadSessionData, 3000);
        loadSessionData(); // Load immediately
      }
    });
  } catch (error) {
    console.error('❌ SSE not supported, using polling', error);
    // Fall back to polling immediately
    pollFallbackInterval = setInterval(loadSessionData, 3000);
    loadSessionData();
  }
}

// ============================================
// POLLING FALLBACK
// ============================================

async function loadSessionData() {
  try {
    const response = await fetch(`${API_BASE}/api/sessions/${workflowId}/${sessionId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const result = await response.json();
    const session = result.session || result;
    
    if (!session || !session.data) {
      showError('No session data found');
      return;
    }
    
    handleSessionUpdate(session);
  } catch (error) {
    console.error('Error loading session data:', error);
    showError(`Failed to load session: ${error.message}`);
  }
}

// ============================================
// SESSION UPDATE HANDLER
// ============================================

function handleSessionUpdate(session) {
  const newJSON = JSON.stringify(session);
  
  // Check if data actually changed
  if (newJSON === currentSessionJSON) {
    // No change, don't re-render
    return;
  }
  
  currentSessionJSON = newJSON;
  currentSessionData = session;
  
  // Update dashboard
  updateDashboard(session);
  
  // Update "Last Updated" time
  updateLastUpdatedTime(session.updatedAt);
}

// ============================================
// DASHBOARD UPDATE LOGIC
// ============================================

function updateDashboard(session) {
  const dashboard = session.data?.dashboard || {};
  const isComplete = dashboard.status === 'complete';
  
  // Check for root cause - handle multiple possible field structures
  const rootCause = session.data?.rootCause;
  const hasRootCause = rootCause && (
    rootCause.identified === true || 
    rootCause.component || 
    rootCause.location || 
    rootCause.description
  );
  
  // Update status bar
  updateStatusBar(dashboard, session);
  
  // Render/update hero (smart update)
  updateHero(dashboard, session.data, isComplete, hasRootCause);
  
  // Render/update cards (smart update)
  updateCards(session.data, isComplete, hasRootCause);
}

function updateStatusBar(dashboard, session) {
  // Status
  const status = dashboard.status || 'in_progress';
  const statusEl = document.getElementById('statusValue');
  const newStatus = status.replace('_', ' ').toUpperCase();
  const isInitialLoad = statusEl.textContent === '--';
  
  if (statusEl.textContent !== newStatus) {
    statusEl.textContent = newStatus;
    statusEl.className = `status-value badge badge-${status}`;
    
    // Only animate if not initial load
    if (!isInitialLoad) {
      statusEl.classList.add('value-updated');
      setTimeout(() => statusEl.classList.remove('value-updated'), 600);
    }
  }
  
  // Progress
  updateNumberWithAnimation('progressValue', dashboard.progress || 0, '%');
  
  // Confidence
  updateNumberWithAnimation('confidenceValue', dashboard.confidence || 0, '/10');
  
  // Current Phase
  updateTextValue('currentPhaseValue', dashboard.currentPhase || '--');
  
  // Duration
  if (dashboard.startedAt) {
    const start = new Date(dashboard.startedAt);
    const end = dashboard.completedAt ? new Date(dashboard.completedAt) : new Date();
    const duration = Math.floor((end - start) / 1000 / 60);
    document.getElementById('durationValue').textContent = `${duration}m`;
  }
}

// ============================================
// HERO SECTION (SMART UPDATE)
// ============================================

function updateHero(dashboard, sessionData, isComplete, hasRootCause) {
  const container = document.getElementById('heroContainer');
  const existingHero = container.querySelector('.hero');
  
  // Determine what hero should be shown
  const shouldShowResult = isComplete && hasRootCause;
  const isCurrentlyResult = existingHero && existingHero.classList.contains('hero-result');
  
  if (shouldShowResult !== isCurrentlyResult) {
    // Hero type changed - swap
    const newHeroHTML = shouldShowResult 
      ? renderCompleteHero(sessionData)
      : renderInProgressHero(dashboard);
    
    if (existingHero) {
      existingHero.classList.add('hero-exit');
      setTimeout(() => {
        container.innerHTML = newHeroHTML;
        const newHero = container.querySelector('.hero');
        newHero.classList.add('hero-enter');
        
        if (shouldShowResult) {
          newHero.classList.add('hero-victory');
          triggerConfetti();
        }
      }, 300);
    } else {
      container.innerHTML = newHeroHTML;
    }
  } else if (existingHero) {
    // Same type - update content without full swap
    const phaseEl = existingHero.querySelector('.hero-phase');
    const stepEl = existingHero.querySelector('.hero-step');
    const progressEl = existingHero.querySelector('.progress-fill');
    
    if (phaseEl) phaseEl.textContent = escapeHtml(dashboard.currentPhase || 'Initializing');
    if (stepEl) stepEl.textContent = escapeHtml(dashboard.currentStep || 'Starting...');
    if (progressEl) progressEl.style.width = `${dashboard.progress || 0}%`;
  } else {
    // First render
    container.innerHTML = shouldShowResult 
      ? renderCompleteHero(sessionData)
      : renderInProgressHero(dashboard);
  }
}

function renderCompleteHero(sessionData) {
  const rootCause = sessionData.rootCause || {};
  const confidence = sessionData.dashboard?.confidence || 0;
  
  // Handle different data structures
  const location = rootCause.location || rootCause.file || 'Unknown';
  const component = rootCause.component || location.split(':')[0] || 'Unknown';
  
  return `
    <div class="hero hero-result">
      <div class="hero-icon">🎯</div>
      <div class="hero-content">
        <h2>✅ ROOT CAUSE IDENTIFIED</h2>
        <div class="hero-subtitle">Investigation Complete</div>
        
        <div class="result-summary">
          <div class="result-item">
            <div class="result-label">Location:</div>
            <div class="result-value"><code>${escapeHtml(location)}</code></div>
          </div>
          <div class="result-item">
            <div class="result-label">Confidence:</div>
            <div class="result-value confidence-high">${confidence.toFixed(1)}/10</div>
          </div>
          ${rootCause.description ? `
          <div class="result-item" style="grid-column: 1 / -1;">
            <div class="result-label">Summary:</div>
            <div class="result-value" style="font-size: 14px; line-height: 1.5;">
              ${escapeHtml(rootCause.description.substring(0, 200))}${rootCause.description.length > 200 ? '...' : ''}
            </div>
          </div>
          ` : ''}
        </div>
        
        <div class="hero-actions">
          <button class="btn-primary" onclick="scrollToCard('root-cause-card')">
            View Root Cause Details →
          </button>
          ${sessionData.fix ? `
          <button class="btn-secondary" onclick="scrollToCard('fix-card')">
            View Recommended Fix →
          </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderInProgressHero(dashboard) {
  const currentPhase = dashboard.currentPhase || 'Initializing';
  const currentStep = dashboard.currentStep || 'Starting investigation...';
  const progress = dashboard.progress || 0;
  
  return `
    <div class="hero hero-in-progress">
      <div class="hero-icon pulse-container">
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
        <div class="pulse-dot"></div>
      </div>
      <div class="hero-content">
        <h2>⚡ CURRENTLY WORKING ON</h2>
        <div class="hero-phase">${escapeHtml(currentPhase)}</div>
        <div class="hero-step">${escapeHtml(currentStep)}</div>
        
        <div class="hero-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress}%"></div>
          </div>
          <div class="progress-text">${progress}% Complete</div>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// CARDS (SMART UPDATE - NO RE-RENDER)
// ============================================

function updateCards(sessionData, isComplete, hasRootCause) {
  const container = document.getElementById('cardsContainer');
  
  // Build list of cards that should exist
  const cardsToShow = [];
  
  // Order matters!
  // When complete: Root Cause and Fix at top
  if (hasRootCause) {
    cardsToShow.push({ id: 'root-cause-card', render: () => renderRootCauseCard(sessionData.rootCause), autoExpand: true });
  }
  
  if (sessionData.fix && sessionData.fix.approach) {
    cardsToShow.push({ id: 'fix-card', render: () => renderFixCard(sessionData.fix), autoExpand: true });
  }
  
  // Always show bug summary
  cardsToShow.push({ id: 'bug-summary-card', render: () => renderBugSummaryCard(sessionData.bugSummary || {}), autoExpand: true });
  
  // Top suspects (if available)
  if (sessionData.dashboard?.topSuspects && sessionData.dashboard.topSuspects.length > 0) {
    cardsToShow.push({ id: 'top-suspects-card', render: () => renderTopSuspectsCard(sessionData.dashboard.topSuspects), autoExpand: true });
  }
  
  // Hypotheses (if any)
  if (sessionData.hypotheses && sessionData.hypotheses.length > 0) {
    cardsToShow.push({ id: 'hypotheses-card', render: () => renderHypothesesCard(sessionData.hypotheses), autoExpand: true });
  }
  
  // Ruled out (if any)
  if (sessionData.ruledOut && sessionData.ruledOut.length > 0) {
    cardsToShow.push({ id: 'ruled-out-card', render: () => renderRuledOutCard(sessionData.ruledOut), autoExpand: false });
  }
  
  // Confidence journey (if has data)
  if (sessionData.confidenceJourney && sessionData.confidenceJourney.length > 0) {
    cardsToShow.push({ id: 'confidence-card', render: () => renderConfidenceCard(sessionData.confidenceJourney), autoExpand: true });
  }
  
  // Timeline (if has events) - ASCENDING order
  if (sessionData.timeline && sessionData.timeline.length > 0) {
    cardsToShow.push({ id: 'timeline-card', render: () => renderTimelineCard(sessionData.timeline), autoExpand: false });
  }
  
  // Add/update cards as needed
  cardsToShow.forEach(cardSpec => {
    let card = document.getElementById(cardSpec.id);
    
    if (!card) {
      // Card doesn't exist - create it
      const cardHTML = cardSpec.render();
      container.insertAdjacentHTML('beforeend', cardHTML);
      card = document.getElementById(cardSpec.id);
      
      // Apply initial expansion state
      if (cardSpec.autoExpand) {
        uiState.expandedCards.add(cardSpec.id);
        card.classList.add('card-expanded');
        card.classList.remove('card-collapsed');
      } else {
        card.classList.add('card-collapsed');
        card.classList.remove('card-expanded');
      }
      
      // Slide in animation - use data attribute to track it's been animated
      card.classList.add('new-section');
      card.dataset.animated = 'false';
      
      // Remove animation class after it completes to prevent retriggering
      setTimeout(() => {
        card.classList.remove('new-section');
        card.dataset.animated = 'true';
      }, 450); // Slightly longer than 400ms animation
    } else {
      // Card exists - update content if needed
      // For now, we'll keep it simple and not update content
      // (content rarely changes once rendered)
    }
    
    // Restore expansion state
    if (uiState.expandedCards.has(cardSpec.id)) {
      card.classList.add('card-expanded');
      card.classList.remove('card-collapsed');
      const toggle = card.querySelector('.card-toggle');
      if (toggle) toggle.textContent = '▲';
    }
  });
  
  // Initialize confidence chart if present and not already initialized
  if (sessionData.confidenceJourney && sessionData.confidenceJourney.length > 0) {
    const chartCanvas = document.getElementById('confidenceChart');
    if (chartCanvas && !confidenceChart) {
      setTimeout(() => initializeConfidenceChart(sessionData.confidenceJourney), 100);
    } else if (confidenceChart && sessionData.confidenceJourney) {
      // Update existing chart
      updateConfidenceChart(sessionData.confidenceJourney);
    }
  }
}

// ============================================
// CARD RENDERERS
// ============================================

function renderBugSummaryCard(bugSummary) {
  return `
    <div class="card card-expanded" id="bug-summary-card">
      <div class="card-header">
        <h3>🐛 Bug Summary</h3>
      </div>
      <div class="card-content">
        <div class="summary-item">
          <strong>Description:</strong>
          <p>${escapeHtml(bugSummary.description || bugSummary.title || 'No description provided')}</p>
        </div>
        ${bugSummary.impact ? `
        <div class="summary-grid">
          <div class="summary-item">
            <strong>Impact:</strong>
            <span class="badge badge-impact-${(bugSummary.impact || '').toLowerCase()}">${escapeHtml(bugSummary.impact)}</span>
          </div>
          <div class="summary-item">
            <strong>Frequency:</strong>
            <span>${escapeHtml(bugSummary.frequency || 'Unknown')}</span>
          </div>
        </div>
        ` : ''}
        ${bugSummary.environment ? `
        <div class="summary-item">
          <strong>Environment:</strong>
          <span>${escapeHtml(bugSummary.environment)}</span>
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderTopSuspectsCard(suspects) {
  return `
    <div class="card card-expanded" id="top-suspects-card">
      <div class="card-header">
        <h3>🎯 Top Suspects</h3>
        <span class="card-count">${suspects.length}</span>
      </div>
      <div class="card-content">
        <div class="suspects-list">
          ${suspects.map((suspect, idx) => `
            <div class="suspect-item">
              <div class="suspect-rank">#${idx + 1}</div>
              <div class="suspect-name"><code>${escapeHtml(suspect)}</code></div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderHypothesesCard(hypotheses) {
  const active = hypotheses.filter(h => h.status !== 'rejected' && h.status !== 'confirmed');
  const confirmed = hypotheses.filter(h => h.status === 'confirmed');
  
  return `
    <div class="card card-expanded" id="hypotheses-card">
      <div class="card-header">
        <h3>💡 Hypotheses</h3>
        <span class="card-count">${hypotheses.length}</span>
      </div>
      <div class="card-content">
        ${confirmed.length > 0 ? `
        <div class="hypotheses-section">
          <h4 class="section-title">✅ Confirmed</h4>
          ${confirmed.map(h => renderHypothesis(h, 'confirmed')).join('')}
        </div>
        ` : ''}
        ${active.length > 0 ? `
        <div class="hypotheses-section">
          <h4 class="section-title">🔄 Testing</h4>
          ${active.map(h => renderHypothesis(h, 'active')).join('')}
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderHypothesis(h, type) {
  return `
    <div class="hypothesis-item hypothesis-${type}">
      <div class="hypothesis-header">
        <span class="hypothesis-id">${h.id}</span>
        <span class="hypothesis-title">${escapeHtml(h.title)}</span>
        <span class="hypothesis-likelihood">Likelihood: ${h.likelihood}/10</span>
      </div>
      <div class="hypothesis-description">${escapeHtml(h.description || '')}</div>
      ${h.evidence && h.evidence.length > 0 ? `
      <div class="hypothesis-evidence">
        <strong>Evidence:</strong>
        <ul>
          ${h.evidence.slice(0, 3).map(e => `<li>${escapeHtml(typeof e === 'string' ? e : e.description || '')}</li>`).join('')}
        </ul>
      </div>
      ` : ''}
    </div>
  `;
}

function renderRuledOutCard(ruledOut) {
  return `
    <div class="card card-collapsed" id="ruled-out-card">
      <div class="card-header" onclick="toggleCard('ruled-out-card')">
        <h3>❌ Ruled Out</h3>
        <span class="card-count">${ruledOut.length}</span>
        <span class="card-toggle">▼</span>
      </div>
      <div class="card-content">
        ${ruledOut.map(r => {
          // Field is called 'item', not 'title' or 'hypothesis'
          const title = r.item || r.title || r.hypothesis || 'Untitled Hypothesis';
          const displayTitle = r.id ? `${r.id}: ${title}` : title;
          return `
            <div class="ruled-out-item">
              <strong>${escapeHtml(displayTitle)}</strong>
              <p>${escapeHtml(r.reason || 'No reason provided')}</p>
              ${r.timestamp ? `<small class="ruled-out-time">Ruled out: ${new Date(r.timestamp).toLocaleString()}</small>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderConfidenceCard(journey) {
  return `
    <div class="card card-expanded" id="confidence-card">
      <div class="card-header">
        <h3>📈 Confidence Journey</h3>
      </div>
      <div class="card-content">
        <canvas id="confidenceChart" width="400" height="200"></canvas>
      </div>
    </div>
  `;
}

function renderTimelineCard(timeline) {
  // Sort ASCENDING (chronological order)
  const sortedTimeline = [...timeline].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  return `
    <div class="card card-collapsed" id="timeline-card">
      <div class="card-header" onclick="toggleCard('timeline-card')">
        <h3>⏱️ Investigation Timeline</h3>
        <span class="card-count">${timeline.length} events</span>
        <span class="card-toggle">▼</span>
      </div>
      <div class="card-content">
        <div class="timeline-list">
          ${sortedTimeline.map(event => `
            <div class="timeline-item">
              <div class="timeline-time">${formatTime(event.timestamp)}</div>
              <div class="timeline-phase">Phase ${event.phase}</div>
              <div class="timeline-event">${escapeHtml(event.event)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderRootCauseCard(rootCause) {
  // Handle different data structures
  const location = rootCause.location || rootCause.file || 'Unknown';
  const component = rootCause.component || location.split(':')[0] || 'Unknown';
  const description = rootCause.description || rootCause.explanation || '';
  
  return `
    <div class="card card-expanded card-highlight" id="root-cause-card">
      <div class="card-header">
        <h3>🎯 Root Cause</h3>
      </div>
      <div class="card-content">
        <div class="root-cause-content">
          ${rootCause.identified !== undefined ? `
          <div class="rc-item">
            <strong>Status:</strong>
            <span class="badge badge-${rootCause.identified ? 'complete' : 'in_progress'}">
              ${rootCause.identified ? '✅ Confirmed' : '🔍 Investigating'}
            </span>
          </div>
          ` : ''}
          <div class="rc-item">
            <strong>Location:</strong>
            <code>${escapeHtml(location)}</code>
          </div>
          ${rootCause.confidence ? `
          <div class="rc-item">
            <strong>Confidence:</strong>
            <span class="badge">${rootCause.confidence}/10</span>
          </div>
          ` : ''}
          ${rootCause.code ? `
          <div class="rc-item">
            <strong>Code:</strong>
            <code>${escapeHtml(rootCause.code)}</code>
          </div>
          ` : ''}
          ${description ? `
          <div class="rc-explanation">
            <strong>Description:</strong>
            <p>${escapeHtml(description)}</p>
          </div>
          ` : ''}
          ${rootCause.mechanism ? `
          <div class="rc-explanation">
            <strong>Mechanism:</strong>
            <p>${escapeHtml(rootCause.mechanism)}</p>
          </div>
          ` : ''}
          ${rootCause.evidence && rootCause.evidence.length > 0 ? `
          <div class="rc-evidence">
            <strong>Evidence:</strong>
            <ul>
              ${rootCause.evidence.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
            </ul>
          </div>
          ` : ''}
          ${rootCause.whyNotCaughtBefore ? `
          <div class="rc-explanation">
            <strong>Why Not Caught Before:</strong>
            <p>${escapeHtml(rootCause.whyNotCaughtBefore)}</p>
          </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderFixCard(fix) {
  return `
    <div class="card card-expanded card-highlight" id="fix-card">
      <div class="card-header">
        <h3>🔧 Recommended Fix</h3>
      </div>
      <div class="card-content">
        <div class="fix-content">
          <div class="fix-item">
            <strong>Approach:</strong>
            <p>${escapeHtml(fix.approach || '')}</p>
          </div>
          ${fix.files && fix.files.length > 0 ? `
          <div class="fix-item">
            <strong>Files Affected:</strong>
            <ul>
              ${fix.files.map(f => `<li><code>${escapeHtml(f)}</code></li>`).join('')}
            </ul>
          </div>
          ` : ''}
          ${fix.estimatedComplexity ? `
          <div class="fix-item">
            <strong>Complexity:</strong>
            <span class="badge badge-complexity-${fix.estimatedComplexity.toLowerCase()}">${escapeHtml(fix.estimatedComplexity)}</span>
          </div>
          ` : ''}
          ${fix.riskAssessment ? `
          <div class="fix-item">
            <strong>Risk Assessment:</strong>
            <p>${escapeHtml(fix.riskAssessment)}</p>
          </div>
          ` : ''}
          ${fix.implementation ? `
          <div class="fix-implementation">
            <strong>Implementation:</strong>
            <p>${escapeHtml(fix.implementation)}</p>
          </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// ============================================
// CHARTS
// ============================================

function initializeConfidenceChart(journey) {
  const canvas = document.getElementById('confidenceChart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  
  if (confidenceChart) {
    confidenceChart.destroy();
  }
  
  confidenceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: journey.map(j => `Phase ${j.phase}`),
      datasets: [{
        label: 'Confidence',
        data: journey.map(j => j.confidence),
        borderColor: '#667eea',
        backgroundColor: 'rgba(102, 126, 234, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 5,
        pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: 10,
          title: {
            display: true,
            text: 'Confidence (0-10)'
          }
        }
      },
      plugins: {
        legend: {
          display: false
        }
      }
    }
  });
}

function updateConfidenceChart(journey) {
  if (!confidenceChart) return;
  
  confidenceChart.data.labels = journey.map(j => `Phase ${j.phase}`);
  confidenceChart.data.datasets[0].data = journey.map(j => j.confidence);
  confidenceChart.update('none'); // Update without animation
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function updateNumberWithAnimation(elementId, newValue, suffix = '') {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  const currentText = element.textContent;
  const oldValue = parseFloat(currentText);
  
  // Check if this is initial load (placeholder text like '--')
  const isInitialLoad = currentText === '--' || isNaN(oldValue);
  
  if (!isInitialLoad && oldValue === newValue) return;
  
  // If initial load, just set the value without animation
  if (isInitialLoad) {
    if (Number.isInteger(newValue)) {
      element.textContent = Math.round(newValue) + suffix;
    } else {
      element.textContent = newValue.toFixed(1) + suffix;
    }
    return;
  }
  
  // Animate count-up
  let start = null;
  const duration = 600;
  
  const step = (timestamp) => {
    if (!start) start = timestamp;
    const progress = Math.min((timestamp - start) / duration, 1);
    const current = oldValue + (newValue - oldValue) * easeOutQuart(progress);
    
    if (Number.isInteger(newValue)) {
      element.textContent = Math.round(current) + suffix;
    } else {
      element.textContent = current.toFixed(1) + suffix;
    }
    
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  
  requestAnimationFrame(step);
  
  // Flash animation (only for actual updates, not initial load)
  element.classList.add('value-updated');
  setTimeout(() => element.classList.remove('value-updated'), 600);
}

function updateTextValue(elementId, newValue) {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  if (element.textContent !== newValue) {
    element.textContent = newValue;
  }
}

function updateLastUpdatedTime(updatedAt) {
  const element = document.getElementById('lastUpdate');
  if (!element) return;
  
  if (updatedAt) {
    const date = new Date(updatedAt);
    element.textContent = `Updated: ${date.toLocaleTimeString()}`;
  } else {
    element.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  }
}

function toggleCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  
  const isExpanded = card.classList.contains('card-expanded');
  
  if (isExpanded) {
    card.classList.remove('card-expanded');
    card.classList.add('card-collapsed');
    uiState.expandedCards.delete(cardId);
  } else {
    card.classList.add('card-expanded');
    card.classList.remove('card-collapsed');
    uiState.expandedCards.add(cardId);
  }
  
  const toggle = card.querySelector('.card-toggle');
  if (toggle) {
    toggle.textContent = isExpanded ? '▼' : '▲';
  }
}

function scrollToCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    // Get scroll offset from CSS variable for maintainability
    const scrollPadding = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--scroll-padding')
    ) || 100; // fallback to 100px
    
    const elementPosition = card.getBoundingClientRect().top;
    const offsetPosition = elementPosition + window.pageYOffset - scrollPadding;
    
    window.scrollTo({
      top: offsetPosition,
      behavior: 'smooth'
    });
    
    // Wait for scroll to complete before flashing
    setTimeout(() => {
      // Only flash if card has finished its entrance animation
      if (card.dataset.animated === 'true' || !card.classList.contains('new-section')) {
        // Simple approach: just add the flash class
        card.classList.remove('card-flash'); // Clear any existing flash
        
        // Use requestAnimationFrame to ensure clean state
        requestAnimationFrame(() => {
          card.classList.add('card-flash');
          
          // Remove after animation completes
          setTimeout(() => {
            card.classList.remove('card-flash');
          }, 2000); // Match animation duration
        });
      } else {
        // Card is still animating in, wait and retry
        setTimeout(() => scrollToCard(cardId), 200);
      }
    }, 300); // Wait for smooth scroll to mostly complete
  }
}

function triggerConfetti() {
  const container = document.getElementById('confetti-container');
  if (!container) return;
  
  const colors = ['#4caf50', '#2196f3', '#ff9800', '#e91e63', '#9c27b0'];
  
  for (let i = 0; i < 50; i++) {
    setTimeout(() => {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      confetti.style.left = `${Math.random() * 100}%`;
      confetti.style.animationDelay = `${Math.random() * 0.5}s`;
      confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
      container.appendChild(confetti);
      
      setTimeout(() => confetti.remove(), 3000);
    }, i * 20);
  }
}

function easeOutQuart(x) {
  return 1 - Math.pow(1 - x, 4);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString();
}

function showError(message) {
  const main = document.querySelector('.dashboard-main');
  main.innerHTML = `
    <div class="error-message">
      <div class="error-icon">❌</div>
      <h2>Error</h2>
      <p>${escapeHtml(message)}</p>
      <a href="/" class="btn-primary">← Back to Home</a>
    </div>
  `;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (eventSource) {
    eventSource.close();
  }
  if (pollFallbackInterval) {
    clearInterval(pollFallbackInterval);
  }
});
