import fs from 'fs';
import path from 'path';
import Ajv, { ErrorObject } from 'ajv';

// Load the workflow schema
const schemaPath = path.resolve(__dirname, '../spec/workflow.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

interface ErrorAnalysis {
  testCase: string;
  input: any;
  errors: ErrorObject[];
  analysis: {
    hasInstancePath: boolean;
    hasParams: boolean;
    hasAdditionalProperty: boolean;
    hasSchemaPath: boolean;
    keyword: string;
    message: string;
  }[];
}

// Test cases designed to trigger different types of validation errors
const testCases: { name: string; input: any }[] = [
  {
    name: "Missing required fields",
    input: {
      id: "test-workflow"
      // Missing name, description, version, steps
    }
  },
  {
    name: "Invalid additional property at root",
    input: {
      id: "test-workflow", 
      name: "Test Workflow",
      description: "A test workflow",
      version: "0.0.1",
      steps: [],
      invalidProperty: "should not be here"
    }
  },
  {
    name: "Invalid additional property in step",
    input: {
      id: "test-workflow",
      name: "Test Workflow", 
      description: "A test workflow",
      version: "0.0.1",
      steps: [{
        id: "step-1",
        title: "Test Step",
        prompt: "Do something",
        invalidStepProperty: "should not be here"
      }]
    }
  },
  {
    name: "Invalid additional property in nested validation rule",
    input: {
      id: "test-workflow",
      name: "Test Workflow",
      description: "A test workflow", 
      version: "0.0.1",
      steps: [{
        id: "step-1",
        title: "Test Step",
        prompt: "Do something",
        validationCriteria: [{
          type: "contains",
          value: "test",
          message: "Must contain test",
          invalidRuleProperty: "should not be here"
        }]
      }]
    }
  },
  {
    name: "Invalid field type",
    input: {
      id: "test-workflow",
      name: 123, // Should be string
      description: "A test workflow",
      version: "0.0.1", 
      steps: []
    }
  },
  {
    name: "Invalid pattern (ID with capitals)",
    input: {
      id: "Test_Workflow!", // Invalid pattern
      name: "Test Workflow",
      description: "A test workflow",
      version: "0.0.1",
      steps: []
    }
  },
  {
    name: "Invalid array item",
    input: {
      id: "test-workflow",
      name: "Test Workflow",
      description: "A test workflow",
      version: "0.0.1",
      steps: [
        "invalid-step-as-string" // Should be object
      ]
    }
  },
  {
    name: "Empty steps array",
    input: {
      id: "test-workflow",
      name: "Test Workflow", 
      description: "A test workflow",
      version: "0.0.1",
      steps: [] // Should have at least one step
    }
  },
  {
    name: "Multiple validation errors",
    input: {
      id: "INVALID_ID", // Invalid pattern
      name: 123, // Invalid type
      description: "A test workflow",
      version: "0.0.1",
      steps: [], // Empty array
      invalidProperty: "should not be here" // Additional property
    }
  },
  {
    name: "Deeply nested validation error",
    input: {
      id: "test-workflow",
      name: "Test Workflow",
      description: "A test workflow",
      version: "0.0.1", 
      steps: [{
        id: "step-1",
        title: "Test Step",
        prompt: "Do something",
        validationCriteria: {
          and: [{
            type: "schema",
            schema: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            },
            message: "Must be valid object",
            invalidNestedProperty: "deeply nested invalid prop"
          }]
        }
      }]
    }
  }
];

function analyzeError(error: ErrorObject): ErrorAnalysis['analysis'][0] {
  return {
    hasInstancePath: error.instancePath !== undefined && error.instancePath !== '',
    hasParams: error.params !== undefined && Object.keys(error.params).length > 0,
    hasAdditionalProperty: error.params?.['additionalProperty'] !== undefined,
    hasSchemaPath: error.schemaPath !== undefined,
    keyword: error.keyword,
    message: error.message || 'No message'
  };
}

function runErrorAnalysis(): ErrorAnalysis[] {
  const results: ErrorAnalysis[] = [];

  console.log('🔍 AJV Error Structure Analysis');
  console.log('=====================================\n');

  for (const testCase of testCases) {
    console.log(`\n📋 Test Case: ${testCase.name}`);
    console.log('─'.repeat(50));
    
    const isValid = validate(testCase.input);
    
    if (isValid) {
      console.log('✅ Valid (unexpected - this should fail)');
      continue;
    }

    const errors = validate.errors || [];
    console.log(`❌ Found ${errors.length} error(s):`);
    
    const analysis: ErrorAnalysis['analysis'] = [];
    
    errors.forEach((error, index) => {
      const errorAnalysis = analyzeError(error);
      analysis.push(errorAnalysis);
      
      console.log(`\n  Error ${index + 1}:`);
      console.log(`    keyword: "${error.keyword}"`);
      console.log(`    message: "${error.message}"`);
      console.log(`    instancePath: "${error.instancePath}"`);
      console.log(`    schemaPath: "${error.schemaPath}"`);
      console.log(`    params:`, JSON.stringify(error.params, null, 6));
      console.log(`    data:`, JSON.stringify(error.data, null, 6));
      
      // Analysis summary
      console.log(`    📊 Analysis:`);
      console.log(`      - Has instancePath: ${errorAnalysis.hasInstancePath}`);
      console.log(`      - Has params: ${errorAnalysis.hasParams}`);
      console.log(`      - Has additionalProperty: ${errorAnalysis.hasAdditionalProperty}`);
      console.log(`      - Has schemaPath: ${errorAnalysis.hasSchemaPath}`);
      
      if (errorAnalysis.hasAdditionalProperty) {
        console.log(`      🎯 additionalProperty: "${error.params?.['additionalProperty']}"`);
      }
    });
    
    results.push({
      testCase: testCase.name,
      input: testCase.input,
      errors: errors,
      analysis: analysis
    });
  }

  return results;
}

// Generate comprehensive summary
function generateSummary(results: ErrorAnalysis[]): void {
  console.log('\n\n📊 COMPREHENSIVE ANALYSIS SUMMARY');
  console.log('=====================================');
  
  const allErrors = results.flatMap(r => r.analysis);
  const keywordCounts = allErrors.reduce((acc, analysis) => {
    acc[analysis.keyword] = (acc[analysis.keyword] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log('\n🔑 Error Keywords Found:');
  Object.entries(keywordCounts).forEach(([keyword, count]) => {
    console.log(`  - ${keyword}: ${count} occurrences`);
  });
  
  console.log('\n📍 InstancePath Coverage:');
  const withInstancePath = allErrors.filter(a => a.hasInstancePath).length;
  const withoutInstancePath = allErrors.filter(a => !a.hasInstancePath).length;
  console.log(`  - With instancePath: ${withInstancePath}`);
  console.log(`  - Without instancePath: ${withoutInstancePath}`);
  
  console.log('\n🎯 AdditionalProperty Coverage:');
  const withAdditionalProperty = allErrors.filter(a => a.hasAdditionalProperty).length;
  const withoutAdditionalProperty = allErrors.filter(a => !a.hasAdditionalProperty).length;
  console.log(`  - With additionalProperty: ${withAdditionalProperty}`);
  console.log(`  - Without additionalProperty: ${withoutAdditionalProperty}`);
  
  console.log('\n📦 Params Coverage:');
  const withParams = allErrors.filter(a => a.hasParams).length;
  const withoutParams = allErrors.filter(a => !a.hasParams).length;
  console.log(`  - With params: ${withParams}`);
  console.log(`  - Without params: ${withoutParams}`);
  
  console.log('\n🎪 Key Insights:');
  console.log('  1. additionalProperties errors:', 
    allErrors.filter(a => a.keyword === 'additionalProperties').length > 0 ? 
    '✅ Confirmed - provides exact property name' : 
    '❌ Not found');
  
  console.log('  2. instancePath reliability:', 
    withInstancePath > withoutInstancePath ? 
    '✅ Reliable - most errors have instancePath' : 
    '⚠️ Inconsistent - some errors lack instancePath');
  
  console.log('  3. Complex nested errors:', 
    allErrors.some(a => a.hasInstancePath && a.hasAdditionalProperty) ? 
    '✅ Supported - nested additional properties detected' : 
    '❌ Not tested');
}

// Export for use in other files
export { runErrorAnalysis, generateSummary, ErrorAnalysis };

// Run analysis if this file is executed directly
if (require.main === module) {
  const results = runErrorAnalysis();
  generateSummary(results);
  
  // Save results to file for reference
  const outputPath = path.resolve(__dirname, 'error-analysis-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${outputPath}`);
} 