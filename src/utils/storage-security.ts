import path from 'path';
import { SecurityError, InvalidWorkflowError } from '../core/error-handler';

/**
 * Storage security utilities extracted from FileWorkflowStorage patterns
 * for consistent security across all storage implementations.
 */

/**
 * Sanitize and validate workflow identifiers for security.
 * Prevents null byte injection and enforces valid character set.
 * 
 * @param id - The workflow identifier to validate
 * @returns Normalized and validated identifier
 * @throws SecurityError for null bytes
 * @throws InvalidWorkflowError for invalid characters
 */
export function sanitizeId(id: string): string {
  if (id.includes('\u0000')) {
    throw new SecurityError('Null byte detected in identifier', 'sanitizeId');
  }

  const normalised = id.normalize('NFC');
  const valid = /^[a-zA-Z0-9_-]+$/.test(normalised);
  if (!valid) {
    throw new InvalidWorkflowError(id, 'Invalid characters in workflow id');
  }
  return normalised;
}

/**
 * Assert that a resolved path stays within the specified base directory.
 * Prevents path traversal attacks by ensuring no directory escape.
 * 
 * @param resolvedPath - The fully resolved absolute path to check
 * @param baseDir - The base directory that should contain the path
 * @throws SecurityError if path escapes the base directory
 */
export function assertWithinBase(resolvedPath: string, baseDir: string): void {
  const platform = process.platform;
  const baseResolved = (platform === 'win32' ? path.win32.resolve(baseDir) : path.resolve(baseDir));
  const targetResolved = (platform === 'win32' ? path.win32.resolve(resolvedPath) : path.resolve(resolvedPath));

  // Windows paths are case-insensitive. Normalize for comparison.
  const base = platform === 'win32' ? baseResolved.toLowerCase() : baseResolved;
  const target = platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;

  const rel = platform === 'win32' ? path.win32.relative(base, target) : path.relative(base, target);
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

  if (escapes) {
    throw new SecurityError('Path escapes storage sandbox', 'file-access');
  }
}

/**
 * Validate file size against security limits.
 * Prevents resource exhaustion and DoS attacks via oversized files.
 * 
 * @param fileSize - Size of the file in bytes
 * @param maxSize - Maximum allowed size in bytes
 * @param context - Context for error reporting (e.g., filename)
 * @throws SecurityError if file exceeds size limit
 */
export function validateFileSize(fileSize: number, maxSize: number, context?: string): void {
  if (fileSize > maxSize) {
    const contextStr = context ? ` (${context})` : '';
    throw new SecurityError(
      `File exceeds size limit of ${maxSize} bytes${contextStr}`,
      'file-size'
    );
  }
}

/**
 * Sanitize and resolve a file path safely within a base directory.
 * Combines path resolution with base directory validation.
 * 
 * @param basePath - The base directory
 * @param relativePath - The relative path to resolve
 * @returns Safely resolved absolute path
 * @throws SecurityError if the resolved path escapes the base
 */
export function securePathResolve(basePath: string, relativePath: string): string {
  const resolvedPath = path.resolve(basePath, relativePath);
  assertWithinBase(resolvedPath, basePath);
  return resolvedPath;
}

/**
 * Validate URL security for remote storage implementations.
 * Ensures URLs use safe protocols and don't target local resources.
 * 
 * @param url - The URL to validate
 * @throws SecurityError for unsafe URLs
 */
export function validateSecureUrl(url: string): void {
  try {
    const parsed = new URL(url);
    
    // Only allow HTTPS and HTTP protocols
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new SecurityError(
        `Unsafe protocol: ${parsed.protocol}. Only HTTP/HTTPS allowed`,
        'url-validation'
      );
    }
    
    // Prevent localhost and private IP access
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) {
      throw new SecurityError(
        'Access to local/private networks not allowed',
        'url-validation'
      );
    }
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    throw new SecurityError(`Invalid URL format: ${url}`, 'url-validation');
  }
}

/**
 * Common security options interface for storage implementations.
 */
export interface StorageSecurityOptions {
  /** Maximum file size in bytes (default: 1MB) */
  maxFileSizeBytes?: number;
  /** Whether to allow HTTP URLs (default: false, HTTPS only) */
  allowHttp?: boolean;
  /** Custom allowed URL patterns (advanced use) */
  allowedUrlPatterns?: RegExp[];
}

/**
 * Default security configuration following FileWorkflowStorage patterns.
 */
export const DEFAULT_SECURITY_OPTIONS: Required<StorageSecurityOptions> = {
  maxFileSizeBytes: 1_000_000, // 1 MB
  allowHttp: false,
  allowedUrlPatterns: []
};

/**
 * Validate security options and apply defaults.
 * 
 * @param options - User-provided security options
 * @returns Validated options with defaults applied
 */
export function validateSecurityOptions(options: StorageSecurityOptions = {}): Required<StorageSecurityOptions> {
  const validated = { ...DEFAULT_SECURITY_OPTIONS, ...options };
  
  if (validated.maxFileSizeBytes <= 0) {
    throw new SecurityError('maxFileSizeBytes must be positive', 'config-validation');
  }
  
  if (validated.maxFileSizeBytes > 100_000_000) { // 100MB upper limit
    throw new SecurityError('maxFileSizeBytes exceeds reasonable limit (100MB)', 'config-validation');
  }
  
  return validated;
} 