import * as fs from 'fs';
import * as path from 'path';

interface TrialData {
  readonly approach: string;
  readonly model: string;
  readonly taskCategory: string;
  readonly taskInstance: string;
  readonly seed: number;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Matrix Solver (Gaussian Elimination)
// ---------------------------------------------------------------------------

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    M.push([...A[i]!, b[i]!]);
  }

  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxEl = Math.abs(M[i]![i]!);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (M[k] && Math.abs(M[k]![i]!) > maxEl) {
        maxEl = Math.abs(M[k]![i]!);
        maxRow = k;
      }
    }

    // Swap row
    const temp = M[maxRow]!;
    M[maxRow] = M[i]!;
    M[i] = temp;

    // Zero out below pivot
    for (let k = i + 1; k < n; k++) {
      const divisor = M[i]![i]!;
      if (Math.abs(divisor) < 1e-12) {
        continue;
      }
      const c = -M[k]![i]! / divisor;
      for (let j = i; j <= n; j++) {
        if (i === j) {
          M[k]![j] = 0;
        } else {
          M[k]![j] += c * M[i]![j]!;
        }
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const divisor = M[i]![i]!;
    if (Math.abs(divisor) < 1e-12) {
      x[i] = 0;
      continue;
    }
    x[i] = M[i]![n]! / divisor;
    for (let k = i - 1; k >= 0; k--) {
      M[k]![n] -= M[k]![i]! * x[i];
    }
  }
  return x;
}

// ---------------------------------------------------------------------------
// Main Analysis Logic
// ---------------------------------------------------------------------------

function main() {
  const resultsPath = path.join(__dirname, 'results.jsonl');
  if (!fs.existsSync(resultsPath)) {
    console.warn('results.jsonl not found. Run the benchmark first to generate results.');
    process.exit(0);
  }

  const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n');
  const data: TrialData[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      data.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines
    }
  }

  if (data.length === 0) {
    console.warn('No trial data found in results.jsonl.');
    process.exit(0);
  }

  console.log('--- Statistical Analysis of Benchmark Results ---');
  console.log(`Total sample size N = ${data.length}\n`);

  // Dynamically extract unique factor levels
  const uniqueApproaches = Array.from(new Set(data.map(d => d.approach)));
  const uniqueModels = Array.from(new Set(data.map(d => d.model)));
  const uniqueCategories = Array.from(new Set(data.map(d => d.taskCategory)));

  // Determine baselines
  const baselineApproach = uniqueApproaches.includes('vanilla')
    ? 'vanilla'
    : (uniqueApproaches[uniqueApproaches.length - 1] || '');
  const baselineModel = uniqueModels.find(m => m.toLowerCase().includes('haiku') || m.toLowerCase().includes('mini'))
    || (uniqueModels[uniqueModels.length - 1] || '');
  const baselineCategory = uniqueCategories.includes('neutral')
    ? 'neutral'
    : (uniqueCategories[uniqueCategories.length - 1] || '');

  console.log('Factor Baseline References:');
  console.log(`  Approach baseline:      ${baselineApproach}`);
  console.log(`  Model baseline:         ${baselineModel}`);
  console.log(`  Task Category baseline: ${baselineCategory}\n`);

  // Build dummy variables mapping (levels excluding baseline)
  const dummyApproaches = uniqueApproaches.filter(a => a !== baselineApproach);
  const dummyModels = uniqueModels.filter(m => m !== baselineModel);
  const dummyCategories = uniqueCategories.filter(c => c !== baselineCategory);

  // Define OLS feature names
  const featureNames: string[] = ['Intercept'];
  for (const a of dummyApproaches) {
    featureNames.push(`Approach: ${a} (vs ${baselineApproach})`);
  }
  for (const m of dummyModels) {
    featureNames.push(`Model: ${m} (vs ${baselineModel})`);
  }
  for (const c of dummyCategories) {
    featureNames.push(`Task Category: ${c} (vs ${baselineCategory})`);
  }

  const p = featureNames.length; // dynamic size

  // Construct design matrix X and response vector Y
  const Y: number[] = [];
  const X: number[][] = [];

  for (const row of data) {
    Y.push(row.score);
    const rowX: number[] = [1]; // intercept

    // Approach dummies
    for (const a of dummyApproaches) {
      rowX.push(row.approach === a ? 1 : 0);
    }
    // Model dummies
    for (const m of dummyModels) {
      rowX.push(row.model === m ? 1 : 0);
    }
    // Category dummies
    for (const c of dummyCategories) {
      rowX.push(row.taskCategory === c ? 1 : 0);
    }

    X.push(rowX);
  }

  const n = Y.length;

  // Compute X^T * X (size p x p) and X^T * Y (size p)
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const XtY: number[] = new Array(p).fill(0);

  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += X[k]![i]! * X[k]![j]!;
      }
      XtX[i]![j] = sum;
    }

    let sumY = 0;
    for (let k = 0; k < n; k++) {
      sumY += X[k]![i]! * Y[k]!;
    }
    XtY[i] = sumY;
  }

  // Solve beta = (X^T * X)^-1 * X^T * Y
  const beta = solveLinearSystem(XtX, XtY);

  // Compute R-squared
  let sumY = 0;
  for (const y of Y) sumY += y;
  const meanY = sumY / n;

  let ssTot = 0;
  let ssRes = 0;
  for (let k = 0; k < n; k++) {
    const yVal = Y[k]!;
    let pred = 0;
    for (let j = 0; j < p; j++) {
      pred += X[k]![j]! * beta[j]!;
    }
    ssTot += Math.pow(yVal - meanY, 2);
    ssRes += Math.pow(yVal - pred, 2);
  }

  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Print results
  console.log('OLS Linear Regression Coefficients:');
  for (let i = 0; i < p; i++) {
    console.log(`  ${featureNames[i]!.padEnd(45)}: ${beta[i]!.toFixed(4)}`);
  }
  console.log('');
  console.log(`R-squared goodness-of-fit: ${rSquared.toFixed(4)}`);
  console.log('------------------------------------------------');
}

main();
