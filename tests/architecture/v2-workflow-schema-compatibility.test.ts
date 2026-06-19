import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

function assertCompatible(oldSchema: any, newSchema: any, path: string): void {
  // If old schema is undefined, any new addition is compatible
  if (oldSchema === undefined) return;

  // If new schema is undefined but old schema was defined, that's a deletion/breaking change
  if (newSchema === undefined) {
    throw new Error(`Breaking change at ${path}: property was deleted.`);
  }

  // Handle $ref special compatibility check
  if (typeof oldSchema === 'object' && oldSchema !== null && '$ref' in oldSchema) {
    // If old schema is a direct reference, new schema can be the same direct reference
    if (typeof newSchema === 'object' && newSchema !== null) {
      if ('$ref' in newSchema) {
        if (oldSchema.$ref !== newSchema.$ref) {
          throw new Error(`Breaking change at ${path}: $ref target changed from ${oldSchema.$ref} to ${newSchema.$ref}`);
        }
        return;
      }
      
      // Or, new schema can wrap it in a oneOf / anyOf array (polymorphism expansion)
      if ('oneOf' in newSchema && Array.isArray(newSchema.oneOf)) {
        const hasCompatibleOption = newSchema.oneOf.some((option: any) => {
          try {
            assertCompatible(oldSchema, option, path);
            return true;
          } catch {
            return false;
          }
        });
        if (hasCompatibleOption) return;
      }
      if ('anyOf' in newSchema && Array.isArray(newSchema.anyOf)) {
        const hasCompatibleOption = newSchema.anyOf.some((option: any) => {
          try {
            assertCompatible(oldSchema, option, path);
            return true;
          } catch {
            return false;
          }
        });
        if (hasCompatibleOption) return;
      }
    }
    throw new Error(`Breaking change at ${path}: $ref was removed or not matched in the new schema`);
  }

  // Handle polymorphism (oneOf, anyOf, allOf) compatibility
  if (typeof oldSchema === 'object' && oldSchema !== null && typeof newSchema === 'object' && newSchema !== null) {
    if ('oneOf' in oldSchema && Array.isArray(oldSchema.oneOf)) {
      if (!('oneOf' in newSchema) || !Array.isArray(newSchema.oneOf)) {
        throw new Error(`Breaking change at ${path}: oneOf was removed or type changed`);
      }
      for (let i = 0; i < oldSchema.oneOf.length; i++) {
        const oldOpt = oldSchema.oneOf[i];
        const hasCompatibleMatch = newSchema.oneOf.some((newOpt: any) => {
          try {
            assertCompatible(oldOpt, newOpt, `${path}.oneOf[${i}]`);
            return true;
          } catch {
            return false;
          }
        });
        if (!hasCompatibleMatch) {
          throw new Error(`Breaking change at ${path}: oneOf option at index ${i} is no longer supported in new schema`);
        }
      }
      return;
    }
    
    if ('anyOf' in oldSchema && Array.isArray(oldSchema.anyOf)) {
      if (!('anyOf' in newSchema) || !Array.isArray(newSchema.anyOf)) {
        throw new Error(`Breaking change at ${path}: anyOf was removed or type changed`);
      }
      for (let i = 0; i < oldSchema.anyOf.length; i++) {
        const oldOpt = oldSchema.anyOf[i];
        const hasCompatibleMatch = newSchema.anyOf.some((newOpt: any) => {
          try {
            assertCompatible(oldOpt, newOpt, `${path}.anyOf[${i}]`);
            return true;
          } catch {
            return false;
          }
        });
        if (!hasCompatibleMatch) {
          throw new Error(`Breaking change at ${path}: anyOf option at index ${i} is no longer supported in new schema`);
        }
      }
      return;
    }

    if ('allOf' in oldSchema && Array.isArray(oldSchema.allOf)) {
      if (!('allOf' in newSchema) || !Array.isArray(newSchema.allOf)) {
        throw new Error(`Breaking change at ${path}: allOf was removed or type changed`);
      }
      for (let i = 0; i < oldSchema.allOf.length; i++) {
        const oldOpt = oldSchema.allOf[i];
        const hasCompatibleMatch = newSchema.allOf.some((newOpt: any) => {
          try {
            assertCompatible(oldOpt, newOpt, `${path}.allOf[${i}]`);
            return true;
          } catch {
            return false;
          }
        });
        if (!hasCompatibleMatch) {
          throw new Error(`Breaking change at ${path}: allOf option at index ${i} is no longer supported in new schema`);
        }
      }
      return;
    }
  }

  // Handle general type mismatch
  if (typeof oldSchema !== typeof newSchema) {
    throw new Error(`Breaking change at ${path}: type changed from ${typeof oldSchema} to ${typeof newSchema}`);
  }

  if (typeof oldSchema !== 'object' || oldSchema === null || newSchema === null) {
    if (oldSchema !== newSchema) {
      throw new Error(`Breaking change at ${path}: value changed from ${oldSchema} to ${newSchema}`);
    }
    return;
  }

  // Handle arrays
  if (Array.isArray(oldSchema)) {
    if (!Array.isArray(newSchema)) {
      throw new Error(`Breaking change at ${path}: array became non-array`);
    }

    // Enum compatibility: new enum must be a superset of old enum
    if (path.endsWith('.enum')) {
      for (const item of oldSchema) {
        if (!newSchema.includes(item)) {
          throw new Error(`Breaking change at ${path}: enum value '${item}' was removed.`);
        }
      }
      return;
    }

    // Required compatibility: new required fields must NOT contain any elements that were NOT in old required fields
    if (path.endsWith('.required')) {
      for (const item of newSchema) {
        if (!oldSchema.includes(item)) {
          throw new Error(`Breaking change at ${path}: new required property '${item}' was added.`);
        }
      }
      return;
    }

    // For general arrays, compare element-by-element
    for (let i = 0; i < oldSchema.length; i++) {
      assertCompatible(oldSchema[i], newSchema[i], `${path}[${i}]`);
    }
    return;
  }

  // Handle objects:
  // - additionalProperties: if old was true/undefined, new cannot be false
  if (oldSchema.additionalProperties !== false && newSchema.additionalProperties === false) {
    throw new Error(`Breaking change at ${path}: additionalProperties changed from allowed to false`);
  }

  // - type compatibility: new type must support all types in old type
  if (
    oldSchema.type !== undefined &&
    newSchema.type !== undefined &&
    (typeof oldSchema.type === 'string' || Array.isArray(oldSchema.type)) &&
    (typeof newSchema.type === 'string' || Array.isArray(newSchema.type))
  ) {
    const oldTypes = Array.isArray(oldSchema.type) ? oldSchema.type : [oldSchema.type];
    const newTypes = Array.isArray(newSchema.type) ? newSchema.type : [newSchema.type];
    for (const t of oldTypes) {
      if (!newTypes.includes(t)) {
        throw new Error(`Breaking change at ${path}: type '${t}' is no longer supported.`);
      }
    }
  }

  // Recursively check all keys present in the old schema
  for (const key of Object.keys(oldSchema)) {
    // Skip version, lastReviewed, and $schema fields at the top-level
    if (path === '$' && ['version', 'lastReviewed', '$schema'].includes(key)) {
      continue;
    }
    // Skip checking $ref here since we handled it above
    if (key === '$ref') {
      continue;
    }
    assertCompatible(oldSchema[key], newSchema[key], `${path}.${key}`);
  }
}

describe('Workflow JSON Schema Backward Compatibility', () => {
  it('should ensure the current workflow.schema.json is backward compatible with origin/main', () => {
    // 1. Read current schema
    const currentSchemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
    let currentSchema: any;
    try {
      currentSchema = JSON.parse(readFileSync(currentSchemaPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`Failed to parse current workflow.schema.json: ${err.message}`);
    }

    // 2. Read base schema from origin/main using git
    let baseSchemaStr = '';
    try {
      baseSchemaStr = execFileSync('git', ['show', 'origin/main:spec/workflow.schema.json'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      try {
        baseSchemaStr = execFileSync('git', ['show', 'main:spec/workflow.schema.json'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch (e2) {
        try {
          baseSchemaStr = execFileSync('git', ['show', 'HEAD~1:spec/workflow.schema.json'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          });
        } catch (e3) {
          console.warn('Skipping workflow schema compatibility check: could not retrieve base version from git (shallow clone or initial commit).');
          return;
        }
      }
    }

    let baseSchema: any;
    try {
      baseSchema = JSON.parse(baseSchemaStr);
    } catch (err: any) {
      console.warn('Skipping compatibility check: Base schema from git is not valid JSON.', err.message);
      return;
    }

    // 3. Run recursive compatibility check
    assertCompatible(baseSchema, currentSchema, '$');
  });
});
