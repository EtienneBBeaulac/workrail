/**
 * ChartBuilder
 * 
 * Lightweight charting system for dashboard visualizations.
 * Pure CSS/SVG implementation - no external dependencies.
 * 
 * Designed for local dashboards with small datasets.
 */

export class ChartBuilder {
  constructor() {
    this.defaultColors = [
      'var(--primary-500)',
      'var(--secondary-500)', 
      'var(--success-500)',
      'var(--warning-500)',
      'var(--error-500)',
      'var(--info-500)'
    ];
  }
  
  /**
   * Create a bar chart
   */
  createBarChart(data, options = {}) {
    const {
      title = '',
      width = 400,
      height = 300,
      showValues = true,
      horizontal = false,
      color = this.defaultColors[0]
    } = options;
    
    try {
      const container = document.createElement('div');
      container.className = 'chart-container bar-chart';
      
      if (title) {
        const titleEl = document.createElement('h4');
        titleEl.className = 'chart-title';
        titleEl.textContent = title;
        container.appendChild(titleEl);
      }
      
      const chartWrapper = document.createElement('div');
      chartWrapper.className = 'chart-wrapper';
      chartWrapper.style.width = `${width}px`;
      chartWrapper.style.height = `${height}px`;
      
      const svg = this.createBarChartSVG(data, { width, height, horizontal, color, showValues });
      chartWrapper.appendChild(svg);
      
      container.appendChild(chartWrapper);
      return container;
      
    } catch (error) {
      console.error('Error creating bar chart:', error);
      return this.createErrorChart('Failed to create bar chart');
    }
  }
  
  /**
   * Create bar chart SVG
   */
  createBarChartSVG(data, options) {
    const { width, height, horizontal, color, showValues } = options;
    const padding = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Extract values
    const values = data.map(d => d.value);
    const maxValue = Math.max(...values, 1);
    
    // Create SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'chart-svg');
    
    // Background
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', width);
    bg.setAttribute('height', height);
    bg.setAttribute('fill', 'var(--bg-primary)');
    svg.appendChild(bg);
    
    // Grid lines
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartHeight * i / 4);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padding.left);
      line.setAttribute('y1', y);
      line.setAttribute('x2', padding.left + chartWidth);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'var(--border-light)');
      line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      
      // Y-axis labels
      const value = maxValue * (4 - i) / 4;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', padding.left - 10);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', 'var(--text-secondary)');
      label.setAttribute('font-size', '12');
      label.textContent = Math.round(value);
      svg.appendChild(label);
    }
    
    // Bars
    const barWidth = chartWidth / data.length * 0.8;
    const barGap = chartWidth / data.length * 0.2;
    
    data.forEach((item, index) => {
      const barHeight = (item.value / maxValue) * chartHeight;
      const x = padding.left + (index * (barWidth + barGap)) + barGap / 2;
      const y = padding.top + chartHeight - barHeight;
      
      // Bar
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', barHeight);
      rect.setAttribute('fill', color);
      rect.setAttribute('rx', '4');
      rect.setAttribute('class', 'chart-bar');
      svg.appendChild(rect);
      
      // Value label
      if (showValues) {
        const valueLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        valueLabel.setAttribute('x', x + barWidth / 2);
        valueLabel.setAttribute('y', y - 5);
        valueLabel.setAttribute('text-anchor', 'middle');
        valueLabel.setAttribute('fill', 'var(--text-primary)');
        valueLabel.setAttribute('font-size', '12');
        valueLabel.setAttribute('font-weight', 'bold');
        valueLabel.textContent = item.value;
        svg.appendChild(valueLabel);
      }
      
      // X-axis label
      const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      xLabel.setAttribute('x', x + barWidth / 2);
      xLabel.setAttribute('y', padding.top + chartHeight + 20);
      xLabel.setAttribute('text-anchor', 'middle');
      xLabel.setAttribute('fill', 'var(--text-secondary)');
      xLabel.setAttribute('font-size', '12');
      xLabel.textContent = item.label;
      svg.appendChild(xLabel);
    });
    
    return svg;
  }
  
  /**
   * Create a line chart
   */
  createLineChart(data, options = {}) {
    const {
      title = '',
      width = 400,
      height = 300,
      showPoints = true,
      color = this.defaultColors[0],
      fill = false
    } = options;
    
    try {
      const container = document.createElement('div');
      container.className = 'chart-container line-chart';
      
      if (title) {
        const titleEl = document.createElement('h4');
        titleEl.className = 'chart-title';
        titleEl.textContent = title;
        container.appendChild(titleEl);
      }
      
      const chartWrapper = document.createElement('div');
      chartWrapper.className = 'chart-wrapper';
      chartWrapper.style.width = `${width}px`;
      chartWrapper.style.height = `${height}px`;
      
      const svg = this.createLineChartSVG(data, { width, height, showPoints, color, fill });
      chartWrapper.appendChild(svg);
      
      container.appendChild(chartWrapper);
      return container;
      
    } catch (error) {
      console.error('Error creating line chart:', error);
      return this.createErrorChart('Failed to create line chart');
    }
  }
  
  /**
   * Create line chart SVG
   */
  createLineChartSVG(data, options) {
    const { width, height, showPoints, color, fill } = options;
    const padding = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    const values = data.map(d => d.value);
    const maxValue = Math.max(...values, 1);
    const minValue = Math.min(...values, 0);
    const valueRange = maxValue - minValue;
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'chart-svg');
    
    // Background
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', width);
    bg.setAttribute('height', height);
    bg.setAttribute('fill', 'var(--bg-primary)');
    svg.appendChild(bg);
    
    // Grid
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartHeight * i / 4);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padding.left);
      line.setAttribute('y1', y);
      line.setAttribute('x2', padding.left + chartWidth);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'var(--border-light)');
      line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
    }
    
    // Line path
    const points = data.map((item, index) => {
      const x = padding.left + (chartWidth * index / (data.length - 1));
      const y = padding.top + chartHeight - ((item.value - minValue) / valueRange * chartHeight);
      return `${x},${y}`;
    });
    
    // Fill area (if enabled)
    if (fill) {
      const firstX = padding.left;
      const lastX = padding.left + chartWidth;
      const bottomY = padding.top + chartHeight;
      
      const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      fillPath.setAttribute('d', `M ${firstX},${bottomY} L ${points.join(' L ')} L ${lastX},${bottomY} Z`);
      fillPath.setAttribute('fill', color);
      fillPath.setAttribute('opacity', '0.2');
      svg.appendChild(fillPath);
    }
    
    // Line
    const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    linePath.setAttribute('points', points.join(' '));
    linePath.setAttribute('fill', 'none');
    linePath.setAttribute('stroke', color);
    linePath.setAttribute('stroke-width', '3');
    linePath.setAttribute('stroke-linecap', 'round');
    linePath.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(linePath);
    
    // Points
    if (showPoints) {
      data.forEach((item, index) => {
        const x = padding.left + (chartWidth * index / (data.length - 1));
        const y = padding.top + chartHeight - ((item.value - minValue) / valueRange * chartHeight);
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', '4');
        circle.setAttribute('fill', 'var(--bg-primary)');
        circle.setAttribute('stroke', color);
        circle.setAttribute('stroke-width', '2');
        svg.appendChild(circle);
      });
    }
    
    return svg;
  }
  
  /**
   * Create a pie/donut chart
   */
  createPieChart(data, options = {}) {
    const {
      title = '',
      size = 300,
      donut = false,
      donutWidth = 60,
      showLabels = true,
      showLegend = true
    } = options;
    
    try {
      const container = document.createElement('div');
      container.className = 'chart-container pie-chart';
      
      if (title) {
        const titleEl = document.createElement('h4');
        titleEl.className = 'chart-title';
        titleEl.textContent = title;
        container.appendChild(titleEl);
      }
      
      const chartWrapper = document.createElement('div');
      chartWrapper.className = 'chart-wrapper';
      chartWrapper.style.display = 'flex';
      chartWrapper.style.gap = 'var(--space-4)';
      chartWrapper.style.alignItems = 'center';
      
      const svg = this.createPieChartSVG(data, { size, donut, donutWidth, showLabels });
      chartWrapper.appendChild(svg);
      
      if (showLegend) {
        const legend = this.createChartLegend(data);
        chartWrapper.appendChild(legend);
      }
      
      container.appendChild(chartWrapper);
      return container;
      
    } catch (error) {
      console.error('Error creating pie chart:', error);
      return this.createErrorChart('Failed to create pie chart');
    }
  }
  
  /**
   * Create pie chart SVG
   */
  createPieChartSVG(data, options) {
    const { size, donut, donutWidth, showLabels } = options;
    const radius = size / 2;
    const center = { x: radius, y: radius };
    
    const total = data.reduce((sum, item) => sum + item.value, 0);
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'chart-svg');
    
    let currentAngle = -90; // Start at top
    
    data.forEach((item, index) => {
      const percentage = item.value / total;
      const angle = percentage * 360;
      const color = this.defaultColors[index % this.defaultColors.length];
      
      // Create slice
      const slice = this.createPieSlice(center, radius, currentAngle, angle, color, donut ? donutWidth : 0);
      svg.appendChild(slice);
      
      currentAngle += angle;
    });
    
    return svg;
  }
  
  /**
   * Create a pie slice path
   */
  createPieSlice(center, radius, startAngle, angle, color, donutWidth) {
    const endAngle = startAngle + angle;
    const innerRadius = donutWidth;
    
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    
    const x1 = center.x + radius * Math.cos(startRad);
    const y1 = center.y + radius * Math.sin(startRad);
    const x2 = center.x + radius * Math.cos(endRad);
    const y2 = center.y + radius * Math.sin(endRad);
    
    const largeArc = angle > 180 ? 1 : 0;
    
    let path;
    if (innerRadius > 0) {
      // Donut
      const x3 = center.x + innerRadius * Math.cos(endRad);
      const y3 = center.y + innerRadius * Math.sin(endRad);
      const x4 = center.x + innerRadius * Math.cos(startRad);
      const y4 = center.y + innerRadius * Math.sin(startRad);
      
      path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    } else {
      // Pie
      path = `M ${center.x} ${center.y} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    }
    
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', path);
    pathEl.setAttribute('fill', color);
    pathEl.setAttribute('class', 'pie-slice');
    
    return pathEl;
  }
  
  /**
   * Create chart legend
   */
  createChartLegend(data) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    
    data.forEach((item, index) => {
      const legendItem = document.createElement('div');
      legendItem.className = 'legend-item';
      
      const colorBox = document.createElement('span');
      colorBox.className = 'legend-color';
      colorBox.style.backgroundColor = this.defaultColors[index % this.defaultColors.length];
      
      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = `${item.label}: ${item.value}`;
      
      legendItem.appendChild(colorBox);
      legendItem.appendChild(label);
      legend.appendChild(legendItem);
    });
    
    return legend;
  }
  
  /**
   * Create progress/gauge chart
   */
  createGaugeChart(value, options = {}) {
    const {
      title = '',
      min = 0,
      max = 100,
      size = 200,
      thickness = 20,
      color = this.defaultColors[0]
    } = options;
    
    try {
      const container = document.createElement('div');
      container.className = 'chart-container gauge-chart';
      
      if (title) {
        const titleEl = document.createElement('h4');
        titleEl.className = 'chart-title';
        titleEl.textContent = title;
        container.appendChild(titleEl);
      }
      
      const percentage = ((value - min) / (max - min)) * 100;
      const svg = this.createGaugeChartSVG(percentage, { size, thickness, color });
      container.appendChild(svg);
      
      const valueLabel = document.createElement('div');
      valueLabel.className = 'gauge-value';
      valueLabel.textContent = `${Math.round(value)}`;
      container.appendChild(valueLabel);
      
      return container;
      
    } catch (error) {
      console.error('Error creating gauge chart:', error);
      return this.createErrorChart('Failed to create gauge chart');
    }
  }
  
  /**
   * Create gauge chart SVG
   */
  createGaugeChartSVG(percentage, options) {
    const { size, thickness, color } = options;
    const radius = (size / 2) - thickness;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'gauge-svg');
    
    // Background circle
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', size / 2);
    bgCircle.setAttribute('cy', size / 2);
    bgCircle.setAttribute('r', radius);
    bgCircle.setAttribute('fill', 'none');
    bgCircle.setAttribute('stroke', 'var(--border-light)');
    bgCircle.setAttribute('stroke-width', thickness);
    svg.appendChild(bgCircle);
    
    // Progress circle
    const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progressCircle.setAttribute('cx', size / 2);
    progressCircle.setAttribute('cy', size / 2);
    progressCircle.setAttribute('r', radius);
    progressCircle.setAttribute('fill', 'none');
    progressCircle.setAttribute('stroke', color);
    progressCircle.setAttribute('stroke-width', thickness);
    progressCircle.setAttribute('stroke-linecap', 'round');
    progressCircle.setAttribute('stroke-dasharray', circumference);
    progressCircle.setAttribute('stroke-dashoffset', offset);
    progressCircle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    svg.appendChild(progressCircle);
    
    return svg;
  }
  
  /**
   * Create error fallback
   */
  createErrorChart(message) {
    const container = document.createElement('div');
    container.className = 'chart-container chart-error';
    container.textContent = `⚠️ ${message}`;
    return container;
  }
}

// Export singleton instance
export const chartBuilder = new ChartBuilder();






