/**
 * Workrail Contrast Checker v1.0
 * Automated WCAG contrast ratio validation
 * 
 * Inspired by LiftKit's automated accessibility checks
 * Ensures all color combinations meet WCAG standards
 */

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Calculate relative luminance
 * https://www.w3.org/TR/WCAG20-TECHS/G17.html
 */
function getLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 * Returns ratio (1-21)
 */
function getContrastRatio(color1, color2) {
  const rgb1 = typeof color1 === 'string' ? hexToRgb(color1) : color1;
  const rgb2 = typeof color2 === 'string' ? hexToRgb(color2) : color2;
  
  if (!rgb1 || !rgb2) return 0;
  
  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);
  
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if contrast ratio meets WCAG standards
 */
function meetsWCAG(ratio, level = 'AA', size = 'normal') {
  const standards = {
    'AA': {
      'normal': 4.5,
      'large': 3.0
    },
    'AAA': {
      'normal': 7.0,
      'large': 4.5
    }
  };
  
  return ratio >= standards[level][size];
}

/**
 * Validate a color combination
 */
function validateContrast(foreground, background, context = '') {
  const ratio = getContrastRatio(foreground, background);
  const meetsAA = meetsWCAG(ratio, 'AA', 'normal');
  const meetsAAA = meetsWCAG(ratio, 'AAA', 'normal');
  
  const result = {
    ratio: ratio.toFixed(2),
    meetsAA,
    meetsAAA,
    foreground,
    background,
    context
  };
  
  if (!meetsAA) {
    console.warn(
      `⚠️ Contrast Issue${context ? ` (${context})` : ''}: ` +
      `${foreground} on ${background} = ${ratio.toFixed(2)}:1 ` +
      `(minimum: 4.5:1 for WCAG AA)`
    );
  } else if (meetsAAA) {
    console.info(
      `✅ Excellent Contrast${context ? ` (${context})` : ''}: ` +
      `${foreground} on ${background} = ${ratio.toFixed(2)}:1 ` +
      `(exceeds WCAG AAA standard)`
    );
  }
  
  return result;
}

/**
 * Validate all design system colors
 */
function validateDesignSystem() {
  const styles = getComputedStyle(document.documentElement);
  
  // Get color values from CSS custom properties
  const colors = {
    textPrimary: styles.getPropertyValue('--text-primary').trim(),
    textSecondary: styles.getPropertyValue('--text-secondary').trim(),
    textTertiary: styles.getPropertyValue('--text-tertiary').trim(),
    bgPrimary: styles.getPropertyValue('--bg-primary').trim(),
    bgSecondary: styles.getPropertyValue('--bg-secondary').trim(),
    statusSuccess: styles.getPropertyValue('--status-success').trim(),
    statusError: styles.getPropertyValue('--status-error').trim(),
    statusActive: styles.getPropertyValue('--status-active').trim(),
    statusPending: styles.getPropertyValue('--status-pending').trim(),
    primary500: styles.getPropertyValue('--primary-500').trim()
  };
  
  console.group('🎨 Design System Contrast Validation');
  
  // Validate common combinations
  const combinations = [
    { fg: colors.textPrimary, bg: colors.bgPrimary, context: 'Primary text on primary bg' },
    { fg: colors.textSecondary, bg: colors.bgPrimary, context: 'Secondary text on primary bg' },
    { fg: colors.textTertiary, bg: colors.bgPrimary, context: 'Tertiary text on primary bg' },
    { fg: colors.textPrimary, bg: colors.bgSecondary, context: 'Primary text on secondary bg' },
    { fg: '#ffffff', bg: colors.statusSuccess, context: 'White text on success bg' },
    { fg: '#ffffff', bg: colors.statusError, context: 'White text on error bg' },
    { fg: '#ffffff', bg: colors.statusActive, context: 'White text on active bg' },
    { fg: '#000000', bg: colors.statusPending, context: 'Black text on pending bg' },
    { fg: '#ffffff', bg: colors.primary500, context: 'White text on primary bg' }
  ];
  
  const results = combinations.map(({ fg, bg, context }) => 
    validateContrast(fg, bg, context)
  );
  
  console.groupEnd();
  
  const passing = results.filter(r => r.meetsAA).length;
  const total = results.length;
  
  console.log(
    `📊 Summary: ${passing}/${total} combinations meet WCAG AA standards ` +
    `(${((passing/total) * 100).toFixed(1)}%)`
  );
  
  return results;
}

/**
 * Monitor DOM for contrast issues
 */
function monitorContrastIssues() {
  if (typeof MutationObserver === 'undefined') return;
  
  const observer = new MutationObserver(() => {
    // Check elements with text
    document.querySelectorAll('[style*="color"]').forEach(el => {
      const fg = getComputedStyle(el).color;
      const bg = getComputedStyle(el).backgroundColor;
      
      if (fg && bg && bg !== 'rgba(0, 0, 0, 0)') {
        const ratio = getContrastRatio(
          parseRgb(fg),
          parseRgb(bg)
        );
        
        if (ratio < 4.5) {
          console.warn(
            `⚠️ Dynamic Contrast Issue on ${el.tagName}: ` +
            `${ratio.toFixed(2)}:1 (minimum: 4.5:1)`
          );
        }
      }
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  });
}

/**
 * Parse rgb/rgba string to object
 */
function parseRgb(rgbString) {
  const match = rgbString.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return {
    r: parseInt(match[1]),
    g: parseInt(match[2]),
    b: parseInt(match[3])
  };
}

/**
 * Auto-run validation on load
 */
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    console.log('🎨 Workrail Contrast Checker loaded');
    validateDesignSystem();
  });
  
  // Export functions globally
  window.WorkrailContrast = {
    getContrastRatio,
    validateContrast,
    validateDesignSystem,
    meetsWCAG,
    monitorContrastIssues
  };
}

// Export for module environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getContrastRatio,
    validateContrast,
    validateDesignSystem,
    meetsWCAG,
    monitorContrastIssues
  };
}

