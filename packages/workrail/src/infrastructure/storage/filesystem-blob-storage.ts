// Filesystem Blob Storage Implementation
// Atomic file operations for context blob storage with integrity checking

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import {
  IBlobStorage,
  ContextStorageConfig,
  BlobStats,
  BlobValidationResult,
  DirectoryInfo
} from './context-storage';
import {
  CompressedBlob,
  BlobMetadata
} from '../../types/context-types';

// =============================================================================
// FILESYSTEM BLOB STORAGE IMPLEMENTATION
// =============================================================================

export class FileSystemBlobStorage implements IBlobStorage {
  private config: ContextStorageConfig;
  private blobDirectory: string;
  private isInitialized = false;

  constructor(config: ContextStorageConfig) {
    this.config = config;
    this.blobDirectory = path.join(config.dataDirectory, config.blobs.directory);
  }

  /**
   * Initialize blob storage by creating directory structure
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create base blob directory
      await this.ensureDirectory(this.blobDirectory);

      // Create subdirectories for better organization (by year/month)
      const currentDate = new Date();
      const yearMonth = `${currentDate.getFullYear()}/${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
      await this.ensureDirectory(path.join(this.blobDirectory, yearMonth));

      this.isInitialized = true;
      console.log('✅ Filesystem blob storage initialized');

    } catch (error) {
      throw new Error(`Failed to initialize filesystem blob storage: ${error}`);
    }
  }

  /**
   * Save compressed blob data with atomic writes and checksum validation
   */
  public async saveBlob(
    sessionId: string, 
    checkpointId: string, 
    blob: CompressedBlob
  ): Promise<BlobMetadata> {
    this.ensureInitialized();

    try {
      // Generate blob path with hierarchical structure
      const blobPath = this.generateBlobPath(sessionId, checkpointId);
      const fullPath = path.join(this.blobDirectory, blobPath);

      // Ensure parent directory exists
      await this.ensureDirectory(path.dirname(fullPath));

      // Calculate checksum for integrity verification
      const checksum = this.calculateChecksum(blob.data);

      // Perform atomic write operation
      await this.atomicWrite(fullPath, blob.data);

      // Verify written file integrity
      await this.verifyFileIntegrity(fullPath, checksum, blob.data.length);

      const metadata: BlobMetadata = {
        checkpointId,
        sessionId,
        path: blobPath,
        sizeBytes: blob.data.length,
        hash: checksum,
        encrypted: false // TODO: Add encryption support
      };

      console.log(`💾 Saved blob: ${blobPath} (${blob.data.length} bytes, ratio: ${blob.compressionRatio.toFixed(2)})`);
      return metadata;

    } catch (error) {
      throw new Error(`Failed to save blob: ${error}`);
    }
  }

  /**
   * Load blob data by metadata with integrity verification
   */
  public async loadBlob(blobMetadata: BlobMetadata): Promise<CompressedBlob> {
    this.ensureInitialized();

    try {
      const fullPath = path.join(this.blobDirectory, blobMetadata.path);

      // Check if file exists
      if (!await this.fileExists(fullPath)) {
        throw new Error(`Blob file not found: ${blobMetadata.path}`);
      }

      // Read file data
      const data = await fs.promises.readFile(fullPath);

      // Verify integrity if checksum validation is enabled
      if (this.config.validation.enableChecksumValidation) {
        const actualChecksum = this.calculateChecksum(data);
        if (actualChecksum !== blobMetadata.hash) {
          throw new Error(
            `Blob integrity check failed for ${blobMetadata.path}. ` +
            `Expected: ${blobMetadata.hash}, Got: ${actualChecksum}`
          );
        }
      }

      // Verify file size matches metadata
      if (data.length !== blobMetadata.sizeBytes) {
        throw new Error(
          `Blob size mismatch for ${blobMetadata.path}. ` +
          `Expected: ${blobMetadata.sizeBytes} bytes, Got: ${data.length} bytes`
        );
      }

      console.log(`📖 Loaded blob: ${blobMetadata.path} (${data.length} bytes)`);

      // Return as CompressedBlob (we'll need to infer compression details)
      return {
        data,
        originalSize: blobMetadata.sizeBytes, // Will be updated by compression service
        compressedSize: data.length,
        compressionRatio: 1.0, // Will be calculated by compression service
        algorithm: 'gzip' // Default assumption, should be stored in metadata
      };

    } catch (error) {
      throw new Error(`Failed to load blob: ${error}`);
    }
  }

  /**
   * Delete blob file with verification
   */
  public async deleteBlob(blobMetadata: BlobMetadata): Promise<void> {
    this.ensureInitialized();

    try {
      const fullPath = path.join(this.blobDirectory, blobMetadata.path);

      // Check if file exists before deletion
      if (await this.fileExists(fullPath)) {
        await fs.promises.unlink(fullPath);
        console.log(`🗑️ Deleted blob: ${blobMetadata.path}`);

        // Clean up empty directories
        await this.cleanupEmptyDirectories(path.dirname(fullPath));
      } else {
        console.warn(`Warning: Blob file not found for deletion: ${blobMetadata.path}`);
      }

    } catch (error) {
      throw new Error(`Failed to delete blob: ${error}`);
    }
  }

  /**
   * Get blob storage statistics
   */
  public async getBlobStats(): Promise<BlobStats> {
    this.ensureInitialized();

    try {
      const directoryInfo = await this.analyzeDirectory(this.blobDirectory);
      const availableSpace = await this.getAvailableSpace();

      return {
        totalFiles: directoryInfo.totalFiles,
        totalSizeBytes: directoryInfo.totalSize,
        averageFileSize: directoryInfo.totalFiles > 0 ? directoryInfo.totalSize / directoryInfo.totalFiles : 0,
        compressionRatio: 1.0, // TODO: Calculate from metadata
        availableSpaceBytes: availableSpace,
        directoryStructure: directoryInfo.subdirectories
      };

    } catch (error) {
      throw new Error(`Failed to get blob stats: ${error}`);
    }
  }

  /**
   * Validate blob integrity across all stored files
   */
  public async validateBlobIntegrity(): Promise<BlobValidationResult> {
    this.ensureInitialized();

    const result: BlobValidationResult = {
      isValid: true,
      corruptedFiles: [],
      missingFiles: [],
      orphanedFiles: [],
      checksumMismatches: []
    };

    try {
      // This is a basic implementation - in practice, we'd need metadata
      // to validate against. For now, just check for file system issues.
      const allFiles = await this.getAllBlobFiles();

      for (const filePath of allFiles) {
        try {
          const fullPath = path.join(this.blobDirectory, filePath);
          const stats = await fs.promises.stat(fullPath);
          
          // Check for obviously corrupted files (0 bytes, etc.)
          if (stats.size === 0) {
            result.corruptedFiles.push(filePath);
            result.isValid = false;
          }

        } catch (error) {
          result.missingFiles.push(filePath);
          result.isValid = false;
        }
      }

      if (result.corruptedFiles.length > 0 || result.missingFiles.length > 0) {
        console.warn(`⚠️ Blob integrity issues found: ${result.corruptedFiles.length} corrupted, ${result.missingFiles.length} missing`);
      } else {
        console.log('✅ Blob integrity validation passed');
      }

      return result;

    } catch (error) {
      throw new Error(`Failed to validate blob integrity: ${error}`);
    }
  }

  /**
   * Cleanup orphaned blob files not referenced by any checkpoint
   */
  public async cleanupOrphanedBlobs(referencedPaths: string[]): Promise<number> {
    this.ensureInitialized();

    try {
      const allFiles = await this.getAllBlobFiles();
      const referencedSet = new Set(referencedPaths);
      let cleanedCount = 0;

      for (const filePath of allFiles) {
        if (!referencedSet.has(filePath)) {
          try {
            const fullPath = path.join(this.blobDirectory, filePath);
            await fs.promises.unlink(fullPath);
            cleanedCount++;
            console.log(`🧹 Cleaned orphaned blob: ${filePath}`);
          } catch (error) {
            console.warn(`Warning: Failed to delete orphaned blob ${filePath}:`, error);
          }
        }
      }

      if (cleanedCount > 0) {
        // Clean up empty directories after orphan cleanup
        await this.cleanupEmptyDirectories(this.blobDirectory);
        console.log(`🧹 Cleaned up ${cleanedCount} orphaned blobs`);
      }

      return cleanedCount;

    } catch (error) {
      throw new Error(`Failed to cleanup orphaned blobs: ${error}`);
    }
  }

  /**
   * Get available disk space
   */
  public async getAvailableSpace(): Promise<number> {
    try {
      // Node.js doesn't have a built-in way to get disk space
      // Use a cross-platform approach by checking if we can write to the directory
      const testFile = path.join(this.blobDirectory, '.space-test');
      await fs.promises.writeFile(testFile, 'test');
      await fs.promises.unlink(testFile);
      
      // Return a large default value since we can write
      // In production, this would be replaced with a proper disk space library
      return 10 * 1024 * 1024 * 1024; // 10GB default
    } catch (error) {
      console.warn('Unable to check available disk space:', error);
      return 1024 * 1024 * 1024; // Return 1GB as conservative fallback
    }
  }

  /**
   * Close blob storage resources
   */
  public async close(): Promise<void> {
    // Filesystem storage doesn't need explicit cleanup
    this.isInitialized = false;
    console.log('📁 Filesystem blob storage closed');
  }

  // =============================================================================
  // PRIVATE HELPER METHODS
  // =============================================================================

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('FileSystemBlobStorage not initialized');
    }
  }

  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.promises.mkdir(dirPath, { 
        recursive: true, 
        mode: this.config.blobs.directoryPermissions 
      });
    } catch (error) {
      throw new Error(`Failed to create directory ${dirPath}: ${error}`);
    }
  }

  private generateBlobPath(sessionId: string, checkpointId: string): string {
    // Create hierarchical path: YYYY/MM/sessionId/checkpointId.gz
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    
    // Use first 8 characters of session ID for directory grouping
    const sessionPrefix = sessionId.substring(0, 8);
    
    return path.join(
      String(year),
      month,
      sessionPrefix,
      `${checkpointId}.json.gz`
    );
  }

  private async atomicWrite(filePath: string, data: Buffer): Promise<void> {
    if (!this.config.blobs.atomicWrites) {
      // Direct write without atomic guarantees
      await fs.promises.writeFile(filePath, data, { mode: this.config.blobs.filePermissions });
      return;
    }

    // Atomic write: write to temp file, then rename
    const tempFile = `${filePath}.tmp.${crypto.randomUUID()}`;
    
    try {
      // Write to temporary file
      await fs.promises.writeFile(tempFile, data, { mode: this.config.blobs.filePermissions });

      // Atomic rename to final location
      await fs.promises.rename(tempFile, filePath);

    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.promises.unlink(tempFile);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private calculateChecksum(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private async verifyFileIntegrity(filePath: string, expectedChecksum: string, expectedSize: number): Promise<void> {
    try {
      const stats = await fs.promises.stat(filePath);
      
      // Verify file size
      if (stats.size !== expectedSize) {
        throw new Error(`File size mismatch: expected ${expectedSize}, got ${stats.size}`);
      }

      // Verify checksum if validation is enabled
      if (this.config.validation.enableChecksumValidation) {
        const data = await fs.promises.readFile(filePath);
        const actualChecksum = this.calculateChecksum(data);
        
        if (actualChecksum !== expectedChecksum) {
          throw new Error(`Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
        }
      }

    } catch (error) {
      throw new Error(`File integrity verification failed: ${error}`);
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async getAllBlobFiles(): Promise<string[]> {
    const files: string[] = [];
    
    const walkDirectory = async (dir: string, basePath = ''): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(basePath, entry.name);
          
          if (entry.isDirectory()) {
            await walkDirectory(fullPath, relativePath);
          } else if (entry.isFile() && entry.name.endsWith('.json.gz')) {
            files.push(relativePath);
          }
        }
      } catch (error) {
        console.warn(`Warning: Failed to read directory ${dir}:`, error);
      }
    };

    await walkDirectory(this.blobDirectory);
    return files;
  }

  private async analyzeDirectory(dirPath: string): Promise<{ totalFiles: number; totalSize: number; subdirectories: DirectoryInfo[] }> {
    const subdirectories: DirectoryInfo[] = [];
    let totalFiles = 0;
    let totalSize = 0;

    const analyzeSubDir = async (subDir: string, relativePath: string): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(subDir, { withFileTypes: true });
        let dirFiles = 0;
        let dirSize = 0;
        let lastModified: Date | undefined;

        for (const entry of entries) {
          const fullPath = path.join(subDir, entry.name);
          
          if (entry.isFile()) {
            const stats = await fs.promises.stat(fullPath);
            dirFiles++;
            dirSize += stats.size;
            totalFiles++;
            totalSize += stats.size;
            
            if (!lastModified || stats.mtime > lastModified) {
              lastModified = stats.mtime;
            }
          } else if (entry.isDirectory()) {
            await analyzeSubDir(fullPath, path.join(relativePath, entry.name));
          }
        }

        if (dirFiles > 0) {
          subdirectories.push({
            path: relativePath,
            fileCount: dirFiles,
            totalSize: dirSize,
            lastModified: lastModified?.toISOString()
          });
        }

      } catch (error) {
        console.warn(`Warning: Failed to analyze directory ${subDir}:`, error);
      }
    };

    try {
      await analyzeSubDir(dirPath, '.');
    } catch (error) {
      console.warn(`Warning: Failed to analyze root directory ${dirPath}:`, error);
    }

    return { totalFiles, totalSize, subdirectories };
  }

  private async cleanupEmptyDirectories(startDir: string): Promise<void> {
    // Don't clean up the root blob directory
    if (startDir === this.blobDirectory) {
      return;
    }

    try {
      const entries = await fs.promises.readdir(startDir);
      
      // If directory is empty, remove it
      if (entries.length === 0) {
        await fs.promises.rmdir(startDir);
        console.log(`🧹 Removed empty directory: ${path.relative(this.blobDirectory, startDir)}`);
        
        // Recursively clean parent directory
        await this.cleanupEmptyDirectories(path.dirname(startDir));
      }
      
    } catch (error) {
      // Ignore errors in cleanup - directory might not be empty or have permissions issues
    }
  }
} 