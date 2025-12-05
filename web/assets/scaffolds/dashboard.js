/**
 * Dashboard Scaffold System
 * High-level builder for complete dashboards
 * 
 * Usage:
 *   import { createDashboard } from '/assets/scaffolds/dashboard.js';
 *   
 *   const dashboard = createDashboard({
 *     workflow: 'bug-investigation',
 *     sessionId: 'DASH-001',
 *     sections: ['hero', 'stats', 'rootCause', 'timeline']
 *   });
 *   
 *   document.getElementById('root').appendChild(dashboard);
 */

import {
  DashboardLayout,
  Grid,
  Stack,
  Card,
  Button,
  Badge,
  StatCard,
  ProgressRing
} from '../components/index.js';

/**
 * Helper: Initialize Lucide icons in card content (light DOM)
 * Since cards use <slot>, content is in light DOM and needs manual icon initialization
 */
function initIconsInCard(card) {
  // Use setTimeout to ensure DOM is fully rendered and slotted
  setTimeout(() => {
    if (typeof lucide !== 'undefined') {
      // Find icons in the card's light DOM children
      const icons = card.querySelectorAll('[data-lucide]');
      icons.forEach(icon => {
        const iconName = icon.getAttribute('data-lucide');
        if (iconName && lucide.icons && lucide.icons[iconName]) {
          const svgElement = lucide.createElement(lucide.icons[iconName]);
          // Copy styles from the icon element
          const style = icon.getAttribute('style');
          if (style) svgElement.setAttribute('style', style);
          icon.parentNode.replaceChild(svgElement, icon);
        }
      });
    }
  }, 0);
}

/**
 * Section builders - each creates a specific dashboard section
 */
const SectionBuilders = {
  
  /**
   * Hero section with title, status, and metadata
   */
  hero(data) {
    const { title, subtitle, sessionId, status, updatedAt } = data;
    
    const header = document.createElement('div');
    header.style.cssText = `
      background: var(--gradient-primary);
      color: white;
      padding: var(--space-8);
      border-radius: var(--radius-xl);
      margin-bottom: var(--space-8);
    `;
    
    const headerContent = document.createElement('div');
    headerContent.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--space-4);
    `;
    
    // Title section
    const titleSection = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.textContent = title || 'Dashboard';
    h1.style.cssText = `
      margin: 0;
      font-size: var(--text-4xl);
      font-weight: var(--font-bold);
    `;
    titleSection.appendChild(h1);
    
    if (subtitle) {
      const p = document.createElement('p');
      p.textContent = subtitle;
      p.style.cssText = `
        margin: var(--space-2) 0 0 0;
        font-size: var(--text-lg);
        opacity: 0.9;
      `;
      titleSection.appendChild(p);
    }
    
    headerContent.appendChild(titleSection);
    
    // Meta section
    const metaSection = document.createElement('div');
    metaSection.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
    `;
    
    if (sessionId) {
      const badge = document.createElement('wr-badge');
      badge.setAttribute('variant', 'neutral');
      badge.style.cssText = `
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border-color: rgba(255, 255, 255, 0.3);
      `;
      badge.textContent = sessionId;
      metaSection.appendChild(badge);
    }
    
    if (status) {
      const statusBadge = document.createElement('wr-badge');
      const statusVariant = status === 'complete' ? 'success' : 'warning';
      statusBadge.setAttribute('variant', statusVariant);
      statusBadge.style.cssText = `
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border-color: rgba(255, 255, 255, 0.3);
      `;
      statusBadge.textContent = status === 'complete' ? 'Complete' : 'In Progress';
      metaSection.appendChild(statusBadge);
    }
    
    if (updatedAt) {
      const time = document.createElement('span');
      time.textContent = `Updated: ${formatTime(updatedAt)}`;
      time.style.cssText = `
        font-size: var(--text-sm);
        opacity: 0.8;
      `;
      metaSection.appendChild(time);
    }
    
    headerContent.appendChild(metaSection);
    header.appendChild(headerContent);
    
    return header;
  },
  
  /**
   * Stats section with progress, confidence, phase
   */
  stats(data) {
    const { progress = 0, confidence = 0, phase = 0, currentPhase } = data;
    
    const grid = document.createElement('wr-grid');
    grid.setAttribute('columns', '3');
    grid.setAttribute('gap', 'lg');
    grid.style.marginBottom = 'var(--space-8)';
    
    // Progress
    const progressCard = document.createElement('wr-stat-card');
    progressCard.setAttribute('label', 'Progress');
    progressCard.setAttribute('value', `${progress}%`);
    progressCard.setAttribute('icon', 'trending-up');
    progressCard.setAttribute('variant', progress >= 75 ? 'success' : 'default');
    grid.appendChild(progressCard);
    
    // Confidence
    const confidenceCard = document.createElement('wr-stat-card');
    confidenceCard.setAttribute('label', 'Confidence');
    confidenceCard.setAttribute('value', `${confidence}/10`);
    confidenceCard.setAttribute('icon', 'target');
    confidenceCard.setAttribute('variant', confidence >= 8 ? 'success' : 'default');
    grid.appendChild(confidenceCard);
    
    // Phase
    const phaseCard = document.createElement('wr-stat-card');
    phaseCard.setAttribute('label', 'Current Phase');
    phaseCard.setAttribute('value', currentPhase || `Phase ${phase}`);
    phaseCard.setAttribute('icon', 'zap');
    phaseCard.setAttribute('variant', 'default');
    grid.appendChild(phaseCard);
    
    return grid;
  },
  
  /**
   * Root cause section
   */
  rootCause(data) {
    if (!data) return null;
    
    // Handle different field names: location/file
    const location = data.location || data.file;
    if (!location) return null;
    
    // Determine if root cause is confirmed (check both identified boolean and status string)
    const isConfirmed = data.identified === true || data.status === 'confirmed';
    
    const card = document.createElement('wr-card');
    card.setAttribute('title', 'Root Cause');
    card.setAttribute('icon', 'target');
    card.setAttribute('variant', 'glass');
    card.setAttribute('border-color', isConfirmed ? 'var(--status-success)' : 'var(--accent-purple)');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    
    // Status badge
    const statusBadge = document.createElement('wr-badge');
    statusBadge.setAttribute('variant', isConfirmed ? 'success' : 'warning');
    statusBadge.setAttribute('icon', isConfirmed ? 'check' : 'alert-circle');
    statusBadge.textContent = isConfirmed ? 'Confirmed' : 'Investigating';
    statusBadge.style.marginBottom = 'var(--space-4)';
    content.appendChild(statusBadge);
    
    // Location
    const locationLabel = document.createElement('div');
    locationLabel.style.cssText = `
      font-size: var(--text-sm);
      font-weight: var(--font-semibold);
      color: var(--text-secondary);
      margin-top: var(--space-4);
      margin-bottom: var(--space-2);
    `;
    locationLabel.textContent = 'Location:';
    content.appendChild(locationLabel);
    
    const locationCode = document.createElement('code');
    locationCode.style.cssText = `
      display: block;
      background: var(--bg-tertiary);
      padding: var(--space-3);
      border-radius: var(--radius-md);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      color: var(--text-primary);
    `;
    locationCode.textContent = location;
    content.appendChild(locationCode);
    
    // Confidence
    if (data.confidence) {
      const confidenceDiv = document.createElement('div');
      confidenceDiv.style.cssText = `
        display: flex;
        align-items: center;
        gap: var(--space-4);
        margin-top: var(--space-4);
      `;
      
      const ring = document.createElement('wr-progress-ring');
      ring.setAttribute('value', data.confidence * 10);
      ring.setAttribute('size', 'sm');
      ring.setAttribute('show-value', '');
      ring.setAttribute('variant', data.confidence >= 8 ? 'success' : 'warning');
      confidenceDiv.appendChild(ring);
      
      const label = document.createElement('span');
      label.style.cssText = `
        font-size: var(--text-sm);
        color: var(--text-secondary);
      `;
      label.textContent = `Confidence: ${data.confidence}/10`;
      confidenceDiv.appendChild(label);
      
      content.appendChild(confidenceDiv);
    }
    
    // Code (if available)
    if (data.code) {
      const codeLabel = document.createElement('div');
      codeLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      codeLabel.textContent = 'Code:';
      content.appendChild(codeLabel);
      
      const codeBlock = document.createElement('pre');
      codeBlock.style.cssText = `
        background: var(--bg-tertiary);
        padding: var(--space-4);
        border-radius: var(--radius-md);
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        color: var(--text-primary);
        overflow-x: auto;
        margin: 0;
      `;
      codeBlock.textContent = data.code;
      content.appendChild(codeBlock);
    }
    
    // Description/Explanation
    const description = data.description || data.explanation || data.summary;
    if (description) {
      const descLabel = document.createElement('div');
      descLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      descLabel.textContent = 'Description:';
      content.appendChild(descLabel);
      
      const descText = document.createElement('p');
      descText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0;
      `;
      descText.textContent = description;
      content.appendChild(descText);
    }
    
    // Mechanism
    if (data.mechanism) {
      const mechLabel = document.createElement('div');
      mechLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      mechLabel.textContent = 'Mechanism:';
      content.appendChild(mechLabel);
      
      const mechText = document.createElement('p');
      mechText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0;
      `;
      mechText.textContent = data.mechanism;
      content.appendChild(mechText);
    }
    
    // Evidence
    if (data.evidence && Array.isArray(data.evidence) && data.evidence.length > 0) {
      const evidenceLabel = document.createElement('div');
      evidenceLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      evidenceLabel.textContent = 'Evidence:';
      content.appendChild(evidenceLabel);
      
      const evidenceList = document.createElement('ul');
      evidenceList.style.cssText = `
        margin: 0;
        padding-left: var(--space-5);
        color: var(--text-secondary);
      `;
      
      data.evidence.forEach(e => {
        const li = document.createElement('li');
        li.style.marginBottom = 'var(--space-2)';
        li.textContent = typeof e === 'string' ? e : (e.description || 'Evidence');
        evidenceList.appendChild(li);
      });
      
      content.appendChild(evidenceList);
    }
    
    // Why Not Caught Before
    if (data.whyNotCaughtBefore) {
      const whyLabel = document.createElement('div');
      whyLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      whyLabel.textContent = 'Why Not Caught Before:';
      content.appendChild(whyLabel);
      
      const whyText = document.createElement('p');
      whyText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0;
      `;
      whyText.textContent = data.whyNotCaughtBefore;
      content.appendChild(whyText);
    }
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Recommended fix section
   */
  fix(data) {
    if (!data || (!data.description && !data.approach)) return null;
    
    const card = document.createElement('wr-card');
    card.setAttribute('title', 'Recommended Fix');
    card.setAttribute('icon', 'wrench');
    card.setAttribute('variant', 'glass');
    card.setAttribute('border-color', 'var(--accent-green)');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    
    // Approach
    const approach = data.approach || data.description;
    if (approach) {
      const approachLabel = document.createElement('div');
      approachLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-bottom: var(--space-2);
      `;
      approachLabel.textContent = 'Approach:';
      content.appendChild(approachLabel);
      
      const approachText = document.createElement('p');
      approachText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0 0 var(--space-4) 0;
      `;
      approachText.textContent = approach;
      content.appendChild(approachText);
    }
    
    // Files Affected
    if (data.files && Array.isArray(data.files) && data.files.length > 0) {
      const filesLabel = document.createElement('div');
      filesLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      filesLabel.textContent = 'Files Affected:';
      content.appendChild(filesLabel);
      
      const filesList = document.createElement('ul');
      filesList.style.cssText = `
        margin: 0;
        padding-left: var(--space-5);
        color: var(--text-secondary);
      `;
      
      data.files.forEach(f => {
        const li = document.createElement('li');
        li.style.marginBottom = 'var(--space-2)';
        const code = document.createElement('code');
        code.style.cssText = `
          background: var(--bg-tertiary);
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-sm);
          font-family: var(--font-mono);
          font-size: var(--text-sm);
        `;
        code.textContent = f;
        li.appendChild(code);
        filesList.appendChild(li);
      });
      
      content.appendChild(filesList);
    }
    
    // Complexity
    if (data.estimatedComplexity) {
      const complexityLabel = document.createElement('div');
      complexityLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      complexityLabel.textContent = 'Complexity:';
      content.appendChild(complexityLabel);
      
      const badge = document.createElement('wr-badge');
      const complexity = data.estimatedComplexity.toLowerCase();
      badge.setAttribute('variant', complexity === 'low' ? 'success' : complexity === 'medium' ? 'warning' : 'error');
      badge.textContent = data.estimatedComplexity;
      content.appendChild(badge);
    }
    
    // Risk Assessment
    if (data.riskAssessment) {
      const riskLabel = document.createElement('div');
      riskLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      riskLabel.textContent = 'Risk Assessment:';
      content.appendChild(riskLabel);
      
      const riskText = document.createElement('p');
      riskText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0;
      `;
      riskText.textContent = data.riskAssessment;
      content.appendChild(riskText);
    }
    
    // Implementation
    if (data.implementation) {
      const implLabel = document.createElement('div');
      implLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      implLabel.textContent = 'Implementation:';
      content.appendChild(implLabel);
      
      const implText = document.createElement('p');
      implText.style.cssText = `
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
        margin: 0;
      `;
      implText.textContent = data.implementation;
      content.appendChild(implText);
    }
    
    // Code if provided
    if (data.code) {
      const codeLabel = document.createElement('div');
      codeLabel.style.cssText = `
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        margin-top: var(--space-6);
        margin-bottom: var(--space-2);
      `;
      codeLabel.textContent = 'Code:';
      content.appendChild(codeLabel);
      
      const codeBlock = document.createElement('pre');
      codeBlock.style.cssText = `
        background: var(--bg-tertiary);
        padding: var(--space-4);
        border-radius: var(--radius-md);
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        color: var(--text-primary);
        overflow-x: auto;
        margin: 0;
      `;
      codeBlock.textContent = data.code;
      content.appendChild(codeBlock);
    }
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Hypotheses section
   */
  hypotheses(data) {
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    
    const card = document.createElement('wr-card');
    card.setAttribute('title', 'Hypotheses');
    card.setAttribute('icon', 'lightbulb');
    card.setAttribute('variant', 'glass');
    card.setAttribute('border-color', 'var(--accent-purple)');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    
    // Group by status
    const confirmed = data.filter(h => h.status === 'confirmed');
    const active = data.filter(h => h.status !== 'rejected' && h.status !== 'confirmed');
    const rejected = data.filter(h => h.status === 'rejected');
    
    // Confirmed hypotheses
    if (confirmed.length > 0) {
      const section = document.createElement('div');
      section.style.marginBottom = 'var(--space-6)';
      
      const sectionTitle = document.createElement('h4');
      sectionTitle.style.cssText = `
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--status-success);
        margin: 0 0 var(--space-4) 0;
        display: flex;
        align-items: center;
        gap: var(--space-2);
      `;
      
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'check-circle');
      icon.style.cssText = 'width: 1em; height: 1em;';
      sectionTitle.appendChild(icon);
      
      const text = document.createTextNode(' Confirmed');
      sectionTitle.appendChild(text);
      
      section.appendChild(sectionTitle);
      
      confirmed.forEach(h => {
        section.appendChild(renderHypothesisItem(h, 'confirmed'));
      });
      
      content.appendChild(section);
    }
    
    // Active/testing hypotheses
    if (active.length > 0) {
      const section = document.createElement('div');
      section.style.marginBottom = 'var(--space-6)';
      
      const sectionTitle = document.createElement('h4');
      sectionTitle.style.cssText = `
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--status-active);
        margin: 0 0 var(--space-4) 0;
        display: flex;
        align-items: center;
        gap: var(--space-2);
      `;
      
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'refresh-cw');
      icon.style.cssText = 'width: 1em; height: 1em;';
      sectionTitle.appendChild(icon);
      
      const text = document.createTextNode(' Testing');
      sectionTitle.appendChild(text);
      
      section.appendChild(sectionTitle);
      
      active.forEach(h => {
        section.appendChild(renderHypothesisItem(h, 'active'));
      });
      
      content.appendChild(section);
    }
    
    // Rejected hypotheses (collapsible)
    if (rejected.length > 0) {
      const section = document.createElement('div');
      
      const sectionTitle = document.createElement('h4');
      sectionTitle.style.cssText = `
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        margin: 0 0 var(--space-4) 0;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        cursor: pointer;
      `;
      
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'x-circle');
      icon.style.cssText = 'width: 1em; height: 1em;';
      sectionTitle.appendChild(icon);
      
      const text = document.createTextNode(` Rejected (${rejected.length})`);
      sectionTitle.appendChild(text);
      
      section.appendChild(sectionTitle);
      
      content.appendChild(section);
    }
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Ruled out section
   */
  ruledOut(data) {
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    
    const card = document.createElement('wr-card');
    card.setAttribute('title', 'Ruled Out');
    card.setAttribute('icon', 'x-circle');
    card.setAttribute('variant', 'glass');
    card.setAttribute('border-color', 'var(--status-error)');
    card.setAttribute('expandable', '');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    
    data.forEach((item, index) => {
      const ruledOutItem = document.createElement('div');
      ruledOutItem.style.cssText = `
        padding: var(--space-4);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-3);
        border-left: 3px solid var(--status-error);
      `;
      
      const title = document.createElement('div');
      title.style.cssText = `
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin-bottom: var(--space-2);
      `;
      const displayTitle = item.item || item.title || item.hypothesis || 'Untitled';
      title.textContent = item.id ? `${item.id}: ${displayTitle}` : displayTitle;
      ruledOutItem.appendChild(title);
      
      if (item.reason) {
        const reason = document.createElement('p');
        reason.style.cssText = `
          color: var(--text-secondary);
          margin: 0 0 var(--space-2) 0;
          font-size: var(--text-sm);
        `;
        reason.textContent = item.reason;
        ruledOutItem.appendChild(reason);
      }
      
      if (item.timestamp) {
        const time = document.createElement('small');
        time.style.cssText = `
          color: var(--text-tertiary);
          font-size: var(--text-xs);
        `;
        time.textContent = `Ruled out: ${new Date(item.timestamp).toLocaleString()}`;
        ruledOutItem.appendChild(time);
      }
      
      content.appendChild(ruledOutItem);
    });
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Timeline section
   */
  timeline(data) {
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    
    const card = document.createElement('wr-card');
    card.setAttribute('title', 'Investigation Timeline');
    card.setAttribute('icon', 'clock');
    card.setAttribute('variant', 'glass');
    card.setAttribute('border-color', 'var(--accent-cyan)');
    card.setAttribute('expandable', '');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    
    // Sort chronologically (ascending)
    const sorted = [...data].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    sorted.forEach((event, index) => {
      const timelineItem = document.createElement('div');
      timelineItem.style.cssText = `
        position: relative;
        padding-left: var(--space-8);
        padding-bottom: var(--space-6);
        border-left: 2px solid var(--border-light);
      `;
      
      // Remove border from last item
      if (index === sorted.length - 1) {
        timelineItem.style.borderLeft = 'none';
      }
      
      // Marker
      const marker = document.createElement('div');
      marker.style.cssText = `
        position: absolute;
        left: -6px;
        top: 4px;
        width: 10px;
        height: 10px;
        background: var(--primary-500);
        border-radius: 50%;
        border: 2px solid var(--bg-primary);
      `;
      timelineItem.appendChild(marker);
      
      // Time
      const time = document.createElement('div');
      time.style.cssText = `
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-bottom: var(--space-1);
      `;
      time.textContent = new Date(event.timestamp).toLocaleString();
      timelineItem.appendChild(time);
      
      // Title
      const title = document.createElement('div');
      title.style.cssText = `
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin-bottom: var(--space-1);
      `;
      title.textContent = event.title || event.event || 'Event';
      timelineItem.appendChild(title);
      
      // Description
      if (event.description) {
        const desc = document.createElement('div');
        desc.style.cssText = `
          font-size: var(--text-sm);
          color: var(--text-secondary);
          line-height: var(--leading-relaxed);
        `;
        desc.textContent = event.description;
        timelineItem.appendChild(desc);
      }
      
      content.appendChild(timelineItem);
    });
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Loading state
   */
  loading() {
    const card = document.createElement('wr-card');
    card.setAttribute('variant', 'glass');
    card.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-20);
      text-align: center;
    `;
    
    const content = document.createElement('div');
    
    const ring = document.createElement('wr-progress-ring');
    ring.setAttribute('value', '75');
    ring.setAttribute('size', 'lg');
    ring.setAttribute('variant', 'primary');
    ring.style.marginBottom = 'var(--space-4)';
    content.appendChild(ring);
    
    const text = document.createElement('p');
    text.style.cssText = `
      color: var(--text-secondary);
      margin: 0;
    `;
    text.textContent = 'Loading dashboard...';
    content.appendChild(text);
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  },
  
  /**
   * Error state
   */
  error(message) {
    const card = document.createElement('wr-card');
    card.setAttribute('variant', 'bordered');
    card.setAttribute('border-color', 'var(--status-error)');
    card.style.marginBottom = 'var(--space-8)';
    
    const content = document.createElement('div');
    content.style.cssText = `
      display: flex;
      align-items: center;
      gap: var(--space-4);
    `;
    
    const badge = document.createElement('wr-badge');
    badge.setAttribute('variant', 'error');
    badge.setAttribute('icon', 'alert-circle');
    badge.textContent = 'Error';
    content.appendChild(badge);
    
    const text = document.createElement('span');
    text.style.cssText = `
      color: var(--text-secondary);
    `;
    text.textContent = message || 'Failed to load dashboard data';
    content.appendChild(text);
    
    card.appendChild(content);
    initIconsInCard(card);
    return card;
  }
};

/**
 * Format timestamp
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Render individual hypothesis item
 */
function renderHypothesisItem(h, type) {
  const item = document.createElement('div');
  item.style.cssText = `
    padding: var(--space-4);
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
    border-left: 3px solid ${type === 'confirmed' ? 'var(--status-success)' : 'var(--status-active)'};
  `;
  
  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  `;
  
  const id = document.createElement('span');
  id.style.cssText = `
    background: ${type === 'confirmed' ? 'var(--status-success)' : 'var(--status-active)'};
    color: white;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: var(--font-bold);
  `;
  id.textContent = h.id || 'H?';
  header.appendChild(id);
  
  const title = document.createElement('span');
  title.style.cssText = `
    flex: 1;
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  `;
  title.textContent = h.title || 'Untitled';
  header.appendChild(title);
  
  const likelihood = document.createElement('span');
  likelihood.style.cssText = `
    font-size: var(--text-sm);
    color: var(--text-secondary);
  `;
  likelihood.textContent = `Likelihood: ${h.likelihood || 0}/10`;
  header.appendChild(likelihood);
  
  item.appendChild(header);
  
  // Description
  if (h.description) {
    const desc = document.createElement('div');
    desc.style.cssText = `
      color: var(--text-secondary);
      font-size: var(--text-sm);
      line-height: var(--leading-relaxed);
      margin-bottom: var(--space-2);
    `;
    desc.textContent = h.description;
    item.appendChild(desc);
  }
  
  // Evidence
  if (h.evidence && Array.isArray(h.evidence) && h.evidence.length > 0) {
    const evidenceContainer = document.createElement('div');
    evidenceContainer.style.cssText = `
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: 1px solid var(--border-light);
    `;
    
    const evidenceLabel = document.createElement('strong');
    evidenceLabel.style.cssText = `
      font-size: var(--text-sm);
      color: var(--text-primary);
      display: block;
      margin-bottom: var(--space-2);
    `;
    evidenceLabel.textContent = 'Evidence:';
    evidenceContainer.appendChild(evidenceLabel);
    
    const evidenceList = document.createElement('ul');
    evidenceList.style.cssText = `
      margin: 0;
      padding-left: var(--space-5);
      color: var(--text-secondary);
      font-size: var(--text-sm);
    `;
    
    h.evidence.slice(0, 3).forEach(e => {
      const li = document.createElement('li');
      li.textContent = typeof e === 'string' ? e : (e.description || 'Evidence');
      evidenceList.appendChild(li);
    });
    
    evidenceContainer.appendChild(evidenceList);
    item.appendChild(evidenceContainer);
  }
  
  return item;
}

/**
 * Create complete dashboard from configuration
 */
export function createDashboard(config) {
  const {
    workflow,
    sessionId,
    dataSource,
    updateInterval = 0,
    realtime = true, // Enable SSE by default
    sections = [],
    onError
  } = config;
  
  let eventSource = null;
  let pollFallbackInterval = null;
  
  // Create layout
  const layout = document.createElement('wr-dashboard-layout');
  layout.setAttribute('max-width', '1200px');
  
  // Header
  const header = document.createElement('div');
  header.setAttribute('slot', 'header');
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-6) var(--space-8);
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-light);
  `;
  
  const backBtn = document.createElement('wr-button');
  backBtn.setAttribute('variant', 'ghost');
  backBtn.setAttribute('icon', 'arrow-left');
  backBtn.textContent = 'All Sessions';
  backBtn.addEventListener('click', () => {
    window.location.href = '/';
  });
  header.appendChild(backBtn);
  
  const title = document.createElement('h1');
  title.style.cssText = `
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  `;
  title.textContent = workflow ? workflow.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Dashboard';
  header.appendChild(title);
  
  const themeToggle = document.createElement('div');
  themeToggle.id = 'theme-toggle-container';
  header.appendChild(themeToggle);
  
  layout.appendChild(header);
  
  // Main content
  const main = document.createElement('div');
  main.setAttribute('slot', 'main');
  main.id = 'dashboard-main';
  
  // Show loading initially
  main.appendChild(SectionBuilders.loading());
  
  layout.appendChild(main);
  
  // Fetch and render data
  if (dataSource) {
    // Try SSE first (real-time), fall back to polling
    if (realtime && workflow && sessionId) {
      connectSSE();
    } else if (updateInterval > 0) {
      // Traditional polling
      fetchAndRender(main, dataSource, sections, onError);
      setInterval(() => {
        fetchAndRender(main, dataSource, sections, onError, true);
      }, updateInterval);
    } else {
      // One-time load
      fetchAndRender(main, dataSource, sections, onError);
    }
  }
  
  // SSE Connection Helper
  function connectSSE() {
    const API_BASE = window.location.origin;
    const sseUrl = `${API_BASE}/api/sessions/${workflow}/${sessionId}/stream`;
    
    console.log(`🔌 Connecting to SSE: ${sseUrl}`);
    
    try {
      eventSource = new EventSource(sseUrl);
      
      eventSource.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        
        if (message.type === 'connected') {
          console.log('✅ SSE Connected - Real-time updates enabled');
          // Clear any polling fallback
          if (pollFallbackInterval) {
            clearInterval(pollFallbackInterval);
            pollFallbackInterval = null;
          }
          // Load initial data
          fetchAndRender(main, dataSource, sections, onError);
        } else if (message.type === 'update') {
          console.log('📡 SSE Update received');
          // Re-render with new data (includes smart diff check)
          fetchAndRender(main, dataSource, sections, onError, true);
        }
      });
      
      eventSource.addEventListener('error', (error) => {
        console.error('❌ SSE Error, falling back to polling', error);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        
        // Fall back to polling
        if (!pollFallbackInterval) {
          const fallbackInterval = updateInterval || 5000;
          console.log(`⏰ Starting polling fallback (${fallbackInterval}ms)`);
          pollFallbackInterval = setInterval(() => {
            fetchAndRender(main, dataSource, sections, onError, true);
          }, fallbackInterval);
          // Load immediately
          fetchAndRender(main, dataSource, sections, onError);
        }
      });
    } catch (error) {
      console.error('❌ SSE not supported, using polling', error);
      // Fall back to polling immediately
      const fallbackInterval = updateInterval || 5000;
      pollFallbackInterval = setInterval(() => {
        fetchAndRender(main, dataSource, sections, onError, true);
      }, fallbackInterval);
      fetchAndRender(main, dataSource, sections, onError);
    }
  }
  
  return layout;
}

/**
 * Fetch data and render sections
 */
async function fetchAndRender(container, dataSource, sections, onError, isUpdate = false) {
  try {
    const response = await fetch(dataSource);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to load session data');
    }
    
    // API returns { success: true, session: { id, workflowId, data: {...} } }
    const session = result.session || result;
    const sessionData = session.data || session;
    
    // Always clear container to prevent duplication
    // TODO: Implement smart diff system to preserve DOM and only update changed elements
    container.innerHTML = '';
    
    // Build sections
    const fragment = document.createDocumentFragment();
    
    sections.forEach(sectionConfig => {
      const sectionType = typeof sectionConfig === 'string' ? sectionConfig : sectionConfig.type;
      const sectionData = typeof sectionConfig === 'object' ? sectionConfig.data : null;
      
      let section;
      
      switch (sectionType) {
        case 'hero':
          section = SectionBuilders.hero({
            title: sessionData.dashboard?.title || 'Dashboard',
            subtitle: 'Real-time workflow execution tracking',
            sessionId: session.id || session.sessionId || sectionData?.sessionId,
            status: sessionData.dashboard?.status,
            updatedAt: session.updatedAt
          });
          break;
          
        case 'stats':
          section = SectionBuilders.stats({
            progress: sessionData.dashboard?.progress || 0,
            confidence: sessionData.dashboard?.confidence || 0,
            phase: sessionData.dashboard?.phase || 0,
            currentPhase: sessionData.dashboard?.currentPhase
          });
          break;
          
        case 'rootCause':
          if (sessionData.rootCause) {
            section = SectionBuilders.rootCause(sessionData.rootCause);
          }
          break;
          
        case 'fix':
          if (sessionData.recommendedFix) {
            section = SectionBuilders.fix(sessionData.recommendedFix);
          }
          break;
          
        case 'hypotheses':
          if (sessionData.hypotheses && sessionData.hypotheses.length > 0) {
            section = SectionBuilders.hypotheses(sessionData.hypotheses);
          }
          break;
          
        case 'ruledOut':
          if (sessionData.ruledOut && sessionData.ruledOut.length > 0) {
            section = SectionBuilders.ruledOut(sessionData.ruledOut);
          }
          break;
          
        case 'timeline':
          if (sessionData.timeline && sessionData.timeline.length > 0) {
            section = SectionBuilders.timeline(sessionData.timeline);
          }
          break;
          
        default:
          console.warn(`Unknown section type: ${sectionType}`);
      }
      
      if (section) {
        fragment.appendChild(section);
      }
    });
    
    if (isUpdate) {
      container.innerHTML = '';
    }
    
    container.appendChild(fragment);
    
    // Re-initialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
    
  } catch (error) {
    console.error('Dashboard error:', error);
    container.innerHTML = '';
    container.appendChild(SectionBuilders.error(error.message));
    
    if (onError) {
      onError(error);
    }
  }
}
