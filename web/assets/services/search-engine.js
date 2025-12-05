/**
 * Search Engine
 * 
 * Fast, fuzzy search for dashboard content with filtering and highlighting.
 */

export class SearchEngine {
  constructor() {
    this.index = [];
    this.data = null;
  }
  
  /**
   * Index dashboard data for searching
   */
  indexData(data) {
    this.data = data;
    this.index = [];
    
    this._indexObject(data, []);
  }
  
  /**
   * Recursively index object
   */
  _indexObject(obj, path) {
    if (!obj || typeof obj !== 'object') {
      return;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key];
      const pathStr = currentPath.join('.');
      
      // Index the field name
      this.index.push({
        path: pathStr,
        type: 'field',
        text: key,
        value: null,
        searchable: this._makeSearchable(key)
      });
      
      // Index based on value type
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        this.index.push({
          path: pathStr,
          type: 'value',
          text: String(value),
          value: value,
          searchable: this._makeSearchable(String(value))
        });
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item && typeof item === 'object') {
            this._indexObject(item, [...currentPath, `[${index}]`]);
          } else {
            this.index.push({
              path: `${pathStr}[${index}]`,
              type: 'value',
              text: String(item),
              value: item,
              searchable: this._makeSearchable(String(item))
            });
          }
        });
      } else if (typeof value === 'object' && value !== null) {
        this._indexObject(value, currentPath);
      }
    }
  }
  
  /**
   * Make text searchable (lowercase, normalized)
   */
  _makeSearchable(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
      .replace(/[^a-z0-9\s]/g, ' ') // Remove special chars
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }
  
  /**
   * Calculate fuzzy match score
   */
  _fuzzyScore(searchable, query) {
    // Exact match
    if (searchable === query) {
      return 1.0;
    }
    
    // Contains query
    if (searchable.includes(query)) {
      const position = searchable.indexOf(query);
      const lengthRatio = query.length / searchable.length;
      const positionPenalty = position / searchable.length;
      return 0.8 * lengthRatio * (1 - positionPenalty * 0.3);
    }
    
    // Word boundary match
    const words = searchable.split(' ');
    for (const word of words) {
      if (word.startsWith(query)) {
        return 0.6;
      }
    }
    
    // Character-by-character fuzzy match
    let matchCount = 0;
    let searchIndex = 0;
    
    for (let i = 0; i < query.length; i++) {
      const char = query[i];
      const found = searchable.indexOf(char, searchIndex);
      
      if (found !== -1) {
        matchCount++;
        searchIndex = found + 1;
      }
    }
    
    if (matchCount === query.length) {
      return 0.3 * (matchCount / searchable.length);
    }
    
    return 0;
  }
  
  /**
   * Search indexed data
   */
  search(query, options = {}) {
    const {
      minScore = 0.1,
      maxResults = 50,
      type = null, // 'field' or 'value'
      path = null  // Filter by path prefix
    } = options;
    
    if (!query || query.length < 2) {
      return [];
    }
    
    const searchableQuery = this._makeSearchable(query);
    const results = [];
    
    for (const entry of this.index) {
      // Apply filters
      if (type && entry.type !== type) continue;
      if (path && !entry.path.startsWith(path)) continue;
      
      // Calculate score
      const score = this._fuzzyScore(entry.searchable, searchableQuery);
      
      if (score >= minScore) {
        results.push({
          ...entry,
          score,
          highlights: this._getHighlights(entry.text, query)
        });
      }
    }
    
    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);
    
    // Limit results
    return results.slice(0, maxResults);
  }
  
  /**
   * Get highlights for matched text
   */
  _getHighlights(text, query) {
    const highlights = [];
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    
    let startIndex = 0;
    while (true) {
      const index = lowerText.indexOf(lowerQuery, startIndex);
      if (index === -1) break;
      
      highlights.push({
        start: index,
        end: index + query.length,
        text: text.substring(index, index + query.length)
      });
      
      startIndex = index + query.length;
    }
    
    return highlights;
  }
  
  /**
   * Filter data by field values
   */
  filter(filters) {
    if (!this.data) return null;
    
    const results = [];
    
    for (const entry of this.index) {
      let matches = true;
      
      for (const [field, value] of Object.entries(filters)) {
        if (entry.path.includes(field)) {
          if (Array.isArray(value)) {
            // OR filter
            if (!value.includes(entry.value)) {
              matches = false;
              break;
            }
          } else {
            // Exact match
            if (entry.value !== value) {
              matches = false;
              break;
            }
          }
        }
      }
      
      if (matches) {
        results.push(entry);
      }
    }
    
    return results;
  }
  
  /**
   * Get all unique values for a field
   */
  getFieldValues(fieldName) {
    const values = new Set();
    
    for (const entry of this.index) {
      if (entry.path.includes(fieldName) && entry.value !== null) {
        values.add(entry.value);
      }
    }
    
    return Array.from(values).sort();
  }
  
  /**
   * Get value at path
   */
  getValueAtPath(path) {
    if (!this.data) return null;
    
    const parts = path.split('.');
    let current = this.data;
    
    for (const part of parts) {
      // Handle array indices
      const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, key, index] = arrayMatch;
        current = current[key];
        if (!Array.isArray(current)) return null;
        current = current[parseInt(index)];
      } else {
        current = current[part];
      }
      
      if (current === undefined) return null;
    }
    
    return current;
  }
}

/**
 * Search UI Component
 */
export class SearchUI {
  constructor(searchEngine, options = {}) {
    this.engine = searchEngine;
    this.onSelect = options.onSelect || null;
    this.element = null;
    this.resultsElement = null;
    this.inputElement = null;
    this.selectedIndex = -1;
    this.results = [];
  }
  
  /**
   * Create search UI
   */
  create() {
    this.element = document.createElement('div');
    this.element.className = 'search-modal';
    this.element.innerHTML = `
      <div class="search-modal-backdrop"></div>
      <div class="search-modal-content" role="dialog" aria-modal="true" aria-labelledby="search-title">
        <div class="search-header">
          <h2 id="search-title" class="sr-only">Search Dashboard</h2>
          <input 
            type="search" 
            class="search-input" 
            placeholder="Search dashboard..."
            aria-label="Search dashboard"
            autocomplete="off"
          />
          <button class="search-close" aria-label="Close search">
            <i data-lucide="x"></i>
          </button>
        </div>
        <div class="search-results" role="listbox" aria-label="Search results"></div>
        <div class="search-footer">
          <kbd>↑↓</kbd> Navigate
          <kbd>Enter</kbd> Select
          <kbd>Esc</kbd> Close
        </div>
      </div>
    `;
    
    this.inputElement = this.element.querySelector('.search-input');
    this.resultsElement = this.element.querySelector('.search-results');
    const closeBtn = this.element.querySelector('.search-close');
    const backdrop = this.element.querySelector('.search-modal-backdrop');
    
    // Event listeners
    this.inputElement.addEventListener('input', (e) => {
      this.handleSearch(e.target.value);
    });
    
    this.inputElement.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });
    
    closeBtn.addEventListener('click', () => {
      this.close();
    });
    
    backdrop.addEventListener('click', () => {
      this.close();
    });
    
    return this.element;
  }
  
  /**
   * Handle search
   */
  handleSearch(query) {
    if (query.length < 2) {
      this.resultsElement.innerHTML = '<div class="search-empty">Type at least 2 characters...</div>';
      this.results = [];
      return;
    }
    
    this.results = this.engine.search(query, { maxResults: 20 });
    this.selectedIndex = -1;
    this.renderResults();
  }
  
  /**
   * Render results
   */
  renderResults() {
    if (this.results.length === 0) {
      this.resultsElement.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }
    
    this.resultsElement.innerHTML = '';
    
    this.results.forEach((result, index) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === this.selectedIndex);
      
      if (index === this.selectedIndex) {
        item.classList.add('selected');
      }
      
      // Highlight matched text
      const highlightedText = this.highlightText(result.text, result.highlights);
      
      item.innerHTML = `
        <div class="search-result-content">
          <div class="search-result-text">${highlightedText}</div>
          <div class="search-result-path">${result.path}</div>
        </div>
        <div class="search-result-type">${result.type}</div>
      `;
      
      item.addEventListener('click', () => {
        this.selectResult(result);
      });
      
      this.resultsElement.appendChild(item);
    });
  }
  
  /**
   * Highlight matched text
   */
  highlightText(text, highlights) {
    if (!highlights || highlights.length === 0) {
      return text;
    }
    
    let result = '';
    let lastIndex = 0;
    
    for (const highlight of highlights) {
      result += text.substring(lastIndex, highlight.start);
      result += `<mark>${text.substring(highlight.start, highlight.end)}</mark>`;
      lastIndex = highlight.end;
    }
    
    result += text.substring(lastIndex);
    return result;
  }
  
  /**
   * Handle keyboard navigation
   */
  handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
      this.renderResults();
      this.scrollToSelected();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
      this.renderResults();
      this.scrollToSelected();
    } else if (e.key === 'Enter' && this.selectedIndex >= 0) {
      e.preventDefault();
      this.selectResult(this.results[this.selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }
  
  /**
   * Scroll to selected result
   */
  scrollToSelected() {
    const selected = this.resultsElement.querySelector('.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  
  /**
   * Select result
   */
  selectResult(result) {
    if (this.onSelect) {
      this.onSelect(result);
    }
    this.close();
  }
  
  /**
   * Open search modal
   */
  open() {
    if (!this.element) {
      this.create();
      document.body.appendChild(this.element);
    }
    
    this.element.classList.add('active');
    this.inputElement.value = '';
    this.inputElement.focus();
    this.resultsElement.innerHTML = '<div class="search-empty">Type to search...</div>';
    
    // Initialize Lucide icons
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      setTimeout(() => lucide.createIcons(), 50);
    }
  }
  
  /**
   * Close search modal
   */
  close() {
    if (this.element) {
      this.element.classList.remove('active');
    }
  }
}

// Export singleton
export const searchEngine = new SearchEngine();






