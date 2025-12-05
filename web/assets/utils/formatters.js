/**
 * Workrail Formatters
 * 
 * Common formatting utilities for displaying session data.
 * Extracted from index.html to eliminate duplication and provide
 * consistent formatting across the dashboard.
 */

/**
 * Format a timestamp as time only (HH:MM:SS AM/PM)
 * 
 * @param {string|Date|number} timestamp - ISO string, Date object, or Unix timestamp
 * @returns {string} Formatted time or 'N/A' if invalid
 * 
 * @example
 * formatTime('2025-10-03T14:30:00Z') // '2:30:00 PM'
 * formatTime(null) // 'N/A'
 */
export function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'N/A';
  
  return date.toLocaleTimeString();
}

/**
 * Format a timestamp as full date and time
 * 
 * @param {string|Date|number} timestamp - ISO string, Date object, or Unix timestamp
 * @returns {string} Formatted date/time or 'N/A' if invalid
 * 
 * @example
 * formatDateTime('2025-10-03T14:30:00Z') // '10/3/2025, 2:30:00 PM'
 */
export function formatDateTime(timestamp) {
  if (!timestamp) return 'N/A';
  
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'N/A';
  
  return date.toLocaleString();
}

/**
 * Format a timestamp as relative time (e.g., "2 minutes ago")
 * 
 * @param {string|Date|number} timestamp - ISO string, Date object, or Unix timestamp
 * @returns {string} Relative time string or 'N/A' if invalid
 * 
 * @example
 * formatRelativeTime(Date.now() - 60000) // '1 minute ago'
 * formatRelativeTime(Date.now() - 3600000) // '1 hour ago'
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return 'N/A';
  
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'N/A';
  
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minute${Math.floor(seconds / 60) !== 1 ? 's' : ''} ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hour${Math.floor(seconds / 3600) !== 1 ? 's' : ''} ago`;
  
  return `${Math.floor(seconds / 86400)} day${Math.floor(seconds / 86400) !== 1 ? 's' : ''} ago`;
}

/**
 * Format progress value as percentage string
 * 
 * @param {number} progress - Progress value (0-100)
 * @returns {string} Formatted percentage with % symbol
 * 
 * @example
 * formatProgress(75) // '75%'
 * formatProgress(0) // '0%'
 */
export function formatProgress(progress) {
  const value = typeof progress === 'number' ? progress : 0;
  return `${Math.round(value)}%`;
}

/**
 * Format confidence value (0-10) as display string
 * 
 * @param {number} confidence - Confidence value (0-10 scale)
 * @param {boolean} includeScale - Whether to include "/10" suffix
 * @returns {string} Formatted confidence
 * 
 * @example
 * formatConfidence(7.5) // '7.5/10'
 * formatConfidence(7.5, false) // '7.5'
 */
export function formatConfidence(confidence, includeScale = true) {
  const value = typeof confidence === 'number' ? confidence : 0;
  const formatted = value.toFixed(1);
  return includeScale ? `${formatted}/10` : formatted;
}

/**
 * Calculate confidence as percentage (for progress bars)
 * 
 * @param {number} confidence - Confidence value (0-10 scale)
 * @returns {number} Percentage (0-100)
 * 
 * @example
 * confidenceToPercent(7.5) // 75
 * confidenceToPercent(10) // 100
 */
export function confidenceToPercent(confidence) {
  const value = typeof confidence === 'number' ? confidence : 0;
  return (value / 10) * 100;
}

/**
 * Format status string for display (replaces underscores with spaces and capitalizes)
 * 
 * @param {string} status - Raw status value
 * @returns {string} Formatted status
 * 
 * @example
 * formatStatus('in_progress') // 'In Progress'
 * formatStatus('complete') // 'Complete'
 */
export function formatStatus(status) {
  if (!status) return 'unknown';
  return status
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get CSS class name for a status
 * 
 * @param {string} status - Status value
 * @returns {string} CSS class name
 * 
 * @example
 * getStatusClass('in_progress') // 'status-in_progress'
 * getStatusClass('complete') // 'status-complete'
 */
export function getStatusClass(status) {
  if (!status) return 'status-unknown';
  return `status-${status}`;
}

/**
 * Get status color/variant for badges and indicators
 * 
 * @param {string} status - Status value
 * @returns {string} Color variant name
 * 
 * @example
 * getStatusVariant('complete') // 'success'
 * getStatusVariant('failed') // 'error'
 * getStatusVariant('in_progress') // 'info'
 */
export function getStatusVariant(status) {
  const statusMap = {
    'complete': 'success',
    'completed': 'success',
    'success': 'success',
    'failed': 'error',
    'error': 'error',
    'in_progress': 'info',
    'active': 'info',
    'pending': 'warning',
    'paused': 'warning',
    'cancelled': 'neutral',
    'canceled': 'neutral'
  };
  
  return statusMap[status] || 'neutral';
}

/**
 * Escape HTML to prevent XSS attacks
 * Essential for user-generated content like session IDs and titles
 * 
 * @param {string} text - Text to escape
 * @returns {string} HTML-safe text
 * 
 * @example
 * escapeHtml('<script>alert("xss")</script>') // '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  
  return text.replace(/[&<>"']/g, char => escapeMap[char]);
}

/**
 * Truncate text to specified length with ellipsis
 * 
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 * 
 * @example
 * truncate('This is a very long title', 15) // 'This is a ve...'
 */
export function truncate(text, maxLength) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Format a number with commas for readability
 * 
 * @param {number} num - Number to format
 * @returns {string} Formatted number
 * 
 * @example
 * formatNumber(1234567) // '1,234,567'
 */
export function formatNumber(num) {
  if (typeof num !== 'number') return '0';
  return num.toLocaleString();
}

/**
 * Format bytes to human-readable size
 * 
 * @param {number} bytes - Number of bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted size string
 * 
 * @example
 * formatBytes(1024) // '1.0 KB'
 * formatBytes(1048576) // '1.0 MB'
 */
export function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Format duration in seconds to human-readable string
 * 
 * @param {number} totalSeconds - Duration in seconds
 * @returns {string} Formatted duration
 * 
 * @example
 * formatDuration(5) // '5s'
 * formatDuration(65) // '1m 5s'
 * formatDuration(3665) // '1h 1m'
 */
export function formatDuration(totalSeconds) {
  if (typeof totalSeconds !== 'number' || totalSeconds < 0) return '0s';
  
  const seconds = Math.floor(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Pluralize a word based on count and include the count in output
 * 
 * @param {number} count - Count to check
 * @param {string} singular - Singular form
 * @param {string} plural - Plural form (optional, defaults to singular + 's')
 * @returns {string} Count with appropriate form
 * 
 * @example
 * pluralize(0, 'item', 'items') // '0 items'
 * pluralize(1, 'item', 'items') // '1 item'
 * pluralize(5, 'item', 'items') // '5 items'
 * pluralize(1, 'hypothesis', 'hypotheses') // '1 hypothesis'
 */
export function pluralize(count, singular, plural = null) {
  const word = count === 1 ? singular : (plural || `${singular}s`);
  return `${count} ${word}`;
}

/**
 * Format count with pluralized label
 * 
 * @param {number} count - Count to display
 * @param {string} singular - Singular form of label
 * @param {string} plural - Plural form (optional)
 * @returns {string} Formatted count with label
 * 
 * @example
 * formatCount(1, 'session') // '1 session'
 * formatCount(5, 'session') // '5 sessions'
 */
export function formatCount(count, singular, plural = null) {
  return `${formatNumber(count)} ${pluralize(count, singular, plural)}`;
}

