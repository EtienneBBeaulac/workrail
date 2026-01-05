import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  sanitizeId,
  assertWithinBase,
  validateFileSize,
  securePathResolve,
  validateSecureUrl,
  validateSecurityOptions,
  DEFAULT_SECURITY_OPTIONS,
  StorageSecurityOptions
} from '../../src/utils/storage-security';
import { SecurityError, InvalidWorkflowError } from '../../src/core/error-handler';

describe('Storage Security Utilities', () => {
  describe('sanitizeId', () => {
    it('should accept valid workflow IDs', () => {
      const validIds = [
        'test-workflow',
        'workflow_123',
        'simple-id',
        'WorkFlow-ID_123',
        'a',
        '123',
        'test-workflow-with-many-parts'
      ];

      for (const id of validIds) {
        expect(() => sanitizeId(id)).not.toThrow();
        expect(sanitizeId(id)).toBe(id.normalize('NFC'));
      }
    });

    it('should reject IDs with null bytes', () => {
      const maliciousIds = [
        'test\u0000workflow',
        '\u0000malicious',
        'workflow\u0000'
      ];

      for (const id of maliciousIds) {
        expect(() => sanitizeId(id)).toThrow(SecurityError);
        expect(() => sanitizeId(id)).toThrow('Null byte detected');
      }
    });

    it('should reject IDs with invalid characters', () => {
      const invalidIds = [
        'test workflow', // space
        'test/workflow', // slash
        'test.workflow', // dot
        'test@workflow', // at symbol
        'test#workflow', // hash
        'test$workflow', // dollar
        'test%workflow', // percent
        'test&workflow', // ampersand
        'test workflow!', // exclamation
        ''  // empty string
      ];

      for (const id of invalidIds) {
        expect(() => sanitizeId(id)).toThrow(InvalidWorkflowError);
      }
    });

    it('should normalize Unicode characters', () => {
      // Unicode characters outside ASCII range should be rejected by the current implementation
      const unicodeId = 'café'; // Contains é which is outside ASCII
      expect(() => sanitizeId(unicodeId)).toThrow(InvalidWorkflowError);
    });
  });

  describe('assertWithinBase', () => {
    const baseDir = path.join(os.tmpdir(), 'workrail-storage-security', 'safe', 'base', 'dir');

    it('should allow paths within base directory', () => {
      const validPaths = [
        path.join(baseDir, 'subdir', 'file.json'),
        path.join(baseDir, 'file.json'),
        baseDir  // base dir itself
      ];

      for (const safePath of validPaths) {
        expect(() => assertWithinBase(safePath, baseDir)).not.toThrow();
      }
    });

    it('should reject paths outside base directory', () => {
      const dangerousPaths = [
        path.dirname(baseDir), // parent of base
        path.join(path.dirname(baseDir), 'different'), // sibling directory
        path.join(os.tmpdir(), 'completely', 'different', 'path'),
        path.join(os.tmpdir(), 'etc', 'passwd')
      ];

      for (const dangerousPath of dangerousPaths) {
        expect(() => assertWithinBase(dangerousPath, baseDir)).toThrow(SecurityError);
        expect(() => assertWithinBase(dangerousPath, baseDir)).toThrow('Path escapes storage sandbox');
      }
    });
  });

  describe('validateFileSize', () => {
    it('should allow files within size limit', () => {
      expect(() => validateFileSize(500, 1000)).not.toThrow();
      expect(() => validateFileSize(1000, 1000)).not.toThrow(); // exactly at limit
      expect(() => validateFileSize(0, 1000)).not.toThrow();
    });

    it('should reject files exceeding size limit', () => {
      expect(() => validateFileSize(1001, 1000)).toThrow(SecurityError);
      expect(() => validateFileSize(1001, 1000)).toThrow('exceeds size limit');
    });

    it('should include context in error message when provided', () => {
      expect(() => validateFileSize(1001, 1000, 'test.json')).toThrow('(test.json)');
    });
  });

  describe('securePathResolve', () => {
    it('should resolve safe relative paths', () => {
      const basePath = path.join(os.tmpdir(), 'workrail-storage-security', 'safe-base');
      expect(securePathResolve(basePath, path.join('subdir', 'file.json'))).toBe(path.join(basePath, 'subdir', 'file.json'));
      expect(securePathResolve(basePath, './file.json')).toBe(path.join(basePath, 'file.json'));
    });

    it('should reject path traversal attempts', () => {
      const basePath = path.join(os.tmpdir(), 'workrail-storage-security', 'safe-base');
      const dangerousRelativePaths = [
        '../../../etc/passwd',
        '../../sensitive',
        '../outside'
      ];

      for (const dangerousPath of dangerousRelativePaths) {
        expect(() => securePathResolve(basePath, dangerousPath)).toThrow(SecurityError);
      }
    });
  });

  describe('validateSecureUrl', () => {
    it('should allow safe HTTPS URLs', () => {
      const safeUrls = [
        'https://example.com/api/workflows',
        'https://api.github.com/repos/org/workflows',
        'https://registry.npmjs.org/package',
        'https://subdomain.example.com:8443/path'
      ];

      for (const url of safeUrls) {
        expect(() => validateSecureUrl(url)).not.toThrow();
      }
    });

    it('should allow HTTP URLs to public domains', () => {
      const httpUrls = [
        'http://example.com/api',
        'http://public-registry.com/workflows'
      ];

      for (const url of httpUrls) {
        expect(() => validateSecureUrl(url)).not.toThrow();
      }
    });

    it('should reject unsafe protocols', () => {
      const unsafeUrls = [
        'file:///etc/passwd',
        'ftp://example.com/file',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>'
      ];

      for (const url of unsafeUrls) {
        expect(() => validateSecureUrl(url)).toThrow(SecurityError);
        expect(() => validateSecureUrl(url)).toThrow('Unsafe protocol');
      }
    });

    it('should reject localhost and private network access', () => {
      const localUrls = [
        'https://localhost/api',
        'https://127.0.0.1/api',
        'https://192.168.1.1/api',
        'https://10.0.0.1/api',
        'https://172.16.0.1/api'
      ];

      for (const url of localUrls) {
        expect(() => validateSecureUrl(url)).toThrow(SecurityError);
        expect(() => validateSecureUrl(url)).toThrow('local/private networks');
      }
    });

    it('should reject malformed URLs', () => {
      const malformedUrls = [
        'not-a-url',
        'https://',
        'https://[invalid',
        'totally invalid'
      ];

      for (const url of malformedUrls) {
        expect(() => validateSecureUrl(url)).toThrow(SecurityError);
        expect(() => validateSecureUrl(url)).toThrow('Invalid URL format');
      }
    });
  });

  describe('validateSecurityOptions', () => {
    it('should apply defaults for empty options', () => {
      const result = validateSecurityOptions();
      expect(result).toEqual(DEFAULT_SECURITY_OPTIONS);
    });

    it('should merge user options with defaults', () => {
      const options: StorageSecurityOptions = {
        maxFileSizeBytes: 500000,
        allowHttp: true
      };
      
      const result = validateSecurityOptions(options);
      expect(result.maxFileSizeBytes).toBe(500000);
      expect(result.allowHttp).toBe(true);
      expect(result.allowedUrlPatterns).toEqual([]); // default
    });

    it('should reject non-positive file size limits', () => {
      expect(() => validateSecurityOptions({ maxFileSizeBytes: 0 })).toThrow(SecurityError);
      expect(() => validateSecurityOptions({ maxFileSizeBytes: -1 })).toThrow(SecurityError);
    });

    it('should reject unreasonably large file size limits', () => {
      expect(() => validateSecurityOptions({ maxFileSizeBytes: 200_000_000 })).toThrow(SecurityError);
      expect(() => validateSecurityOptions({ maxFileSizeBytes: 200_000_000 })).toThrow('exceeds reasonable limit');
    });

    it('should accept reasonable file size limits', () => {
      const validSizes = [1, 1000, 1_000_000, 50_000_000, 100_000_000];
      
      for (const size of validSizes) {
        expect(() => validateSecurityOptions({ maxFileSizeBytes: size })).not.toThrow();
      }
    });
  });

  describe('DEFAULT_SECURITY_OPTIONS', () => {
    it('should have sensible default values', () => {
      expect(DEFAULT_SECURITY_OPTIONS.maxFileSizeBytes).toBe(1_000_000); // 1MB
      expect(DEFAULT_SECURITY_OPTIONS.allowHttp).toBe(false);
      expect(DEFAULT_SECURITY_OPTIONS.allowedUrlPatterns).toEqual([]);
    });
  });
}); 