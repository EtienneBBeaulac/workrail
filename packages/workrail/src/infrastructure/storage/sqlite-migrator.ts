// SQLite Migration Runner for Context Management Database
// Handles schema migrations with transaction safety and error recovery

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

export interface Migration {
  version: number;
  filename: string;
  description: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  success: boolean;
  appliedVersion?: number;
  error?: string;
  rollbackPerformed?: boolean;
  duration?: number;
}

export interface MigrationStatus {
  currentVersion: number;
  targetVersion: number;
  pendingMigrations: Migration[];
  appliedMigrations: AppliedMigration[];
}

export interface AppliedMigration {
  version: number;
  description: string;
  appliedAt: string;
  checksum: string;
}

// =============================================================================
// SQLITE MIGRATOR CLASS
// =============================================================================

export class SqliteMigrator {
  private db: Database.Database;
  private migrationsDir: string;
  private readonly maxRetries = 3;
  private readonly lockTimeout = 10000; // 10 seconds

  constructor(
    databasePath: string,
    migrationsDir?: string
  ) {
    // Initialize database connection with optimized settings
    this.db = new Database(databasePath, {
      verbose: undefined, // Disable verbose logging in production
      fileMustExist: false,
      timeout: this.lockTimeout
    });

    // Configure SQLite for optimal performance and reliability
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    this.db.pragma('synchronous = NORMAL'); // Balance between safety and performance
    this.db.pragma('cache_size = 1000'); // 1000 pages cache
    this.db.pragma('temp_store = memory'); // Store temp tables in memory
    this.db.pragma('foreign_keys = ON'); // Enable foreign key constraints

    this.migrationsDir = migrationsDir || path.join(__dirname, 'migrations');
  }

  /**
   * Initialize the migration system by ensuring schema_version table exists
   */
  public async initialize(): Promise<void> {
    try {
      // Create schema_version table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          description TEXT NOT NULL,
          checksum TEXT NOT NULL,
          migration_duration_ms INTEGER DEFAULT NULL
        );
      `);

      // Create migration locks table for concurrent safety
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migration_locks (
          id TEXT PRIMARY KEY DEFAULT 'migration_lock',
          locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          locked_by TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          CHECK (id = 'migration_lock')
        );
      `);

      console.log('✅ Migration system initialized');
    } catch (error) {
      throw new Error(`Failed to initialize migration system: ${error}`);
    }
  }

  /**
   * Get current database schema version
   */
  public getCurrentVersion(): number {
    try {
      const result = this.db
        .prepare('SELECT MAX(version) as version FROM schema_version')
        .get() as { version: number | null };
      
      return result?.version ?? 0;
    } catch (error) {
      // If schema_version table doesn't exist, we're at version 0
      return 0;
    }
  }

  /**
   * Load all available migrations from the migrations directory
   */
  public loadAvailableMigrations(): Migration[] {
    try {
      if (!fs.existsSync(this.migrationsDir)) {
        console.warn(`Migrations directory not found: ${this.migrationsDir}`);
        return [];
      }

      const files = fs.readdirSync(this.migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort(); // Ensure consistent ordering

      const migrations: Migration[] = [];

      for (const filename of files) {
        const match = filename.match(/^(\d+)_(.+)\.sql$/);
        if (!match) {
          console.warn(`Skipping invalid migration filename: ${filename}`);
          continue;
        }

        const version = parseInt(match[1], 10);
        const description = match[2].replace(/[_-]/g, ' ');
        const filepath = path.join(this.migrationsDir, filename);
        const sql = fs.readFileSync(filepath, 'utf-8');
        const checksum = this.calculateChecksum(sql);

        migrations.push({
          version,
          filename,
          description,
          sql,
          checksum
        });
      }

      return migrations.sort((a, b) => a.version - b.version);
    } catch (error) {
      throw new Error(`Failed to load migrations: ${error}`);
    }
  }

  /**
   * Get migration status including current version and pending migrations
   */
  public getMigrationStatus(): MigrationStatus {
    const currentVersion = this.getCurrentVersion();
    const availableMigrations = this.loadAvailableMigrations();
    const pendingMigrations = availableMigrations.filter(m => m.version > currentVersion);
    const targetVersion = Math.max(...availableMigrations.map(m => m.version), currentVersion);

    // Get applied migrations
    const appliedMigrations: AppliedMigration[] = this.db
      .prepare('SELECT version, description, applied_at, checksum FROM schema_version ORDER BY version')
      .all() as AppliedMigration[];

    return {
      currentVersion,
      targetVersion,
      pendingMigrations,
      appliedMigrations
    };
  }

  /**
   * Apply all pending migrations
   */
  public async migrate(): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];
    const status = this.getMigrationStatus();

    if (status.pendingMigrations.length === 0) {
      console.log('📊 Database is up to date');
      return results;
    }

    console.log(`📊 Applying ${status.pendingMigrations.length} pending migrations...`);

    for (const migration of status.pendingMigrations) {
      const result = await this.applyMigration(migration);
      results.push(result);

      if (!result.success) {
        console.error(`❌ Migration failed at version ${migration.version}, stopping`);
        break;
      }
    }

    return results;
  }

  /**
   * Apply a single migration with transaction safety
   */
  private async applyMigration(migration: Migration): Promise<MigrationResult> {
    const startTime = Date.now();
    let lockId: string | null = null;

    try {
      // Acquire migration lock
      lockId = await this.acquireMigrationLock();

      // Verify migration hasn't been applied by another process
      const currentVersion = this.getCurrentVersion();
      if (migration.version <= currentVersion) {
        await this.releaseMigrationLock(lockId);
        return {
          success: true,
          appliedVersion: migration.version,
          duration: Date.now() - startTime
        };
      }

      // Validate migration checksum against previously applied version
      await this.validateMigrationChecksum(migration);

      console.log(`📦 Applying migration ${migration.version}: ${migration.description}`);

      // Apply migration in transaction
      const transaction = this.db.transaction(() => {
        // Execute migration SQL
        this.db.exec(migration.sql);

        // Record successful migration
        this.db
          .prepare(`
            INSERT INTO schema_version (version, description, checksum, migration_duration_ms) 
            VALUES (?, ?, ?, ?)
          `)
          .run(
            migration.version,
            migration.description,
            migration.checksum,
            Date.now() - startTime
          );
      });

      transaction();

      const duration = Date.now() - startTime;
      console.log(`✅ Migration ${migration.version} completed in ${duration}ms`);

      await this.releaseMigrationLock(lockId);

      return {
        success: true,
        appliedVersion: migration.version,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Migration ${migration.version} failed:`, error);

      // Release lock if we acquired it
      if (lockId) {
        try {
          await this.releaseMigrationLock(lockId);
        } catch (lockError) {
          console.error('Failed to release migration lock:', lockError);
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration
      };
    }
  }

  /**
   * Acquire exclusive migration lock with timeout
   */
  private async acquireMigrationLock(): Promise<string> {
    const lockId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + this.lockTimeout);
    let attempts = 0;

    while (attempts < this.maxRetries) {
      try {
        // Clean up expired locks first
        this.db
          .prepare('DELETE FROM migration_locks WHERE expires_at < CURRENT_TIMESTAMP')
          .run();

        // Try to acquire lock
        this.db
          .prepare(`
            INSERT INTO migration_locks (locked_by, expires_at) 
            VALUES (?, ?)
          `)
          .run(lockId, expiresAt.toISOString());

        return lockId;

      } catch (error) {
        attempts++;
        if (attempts >= this.maxRetries) {
          throw new Error(`Failed to acquire migration lock after ${this.maxRetries} attempts`);
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Unable to acquire migration lock');
  }

  /**
   * Release migration lock
   */
  private async releaseMigrationLock(lockId: string): Promise<void> {
    try {
      this.db
        .prepare('DELETE FROM migration_locks WHERE locked_by = ?')
        .run(lockId);
    } catch (error) {
      console.warn(`Failed to release migration lock ${lockId}:`, error);
    }
  }

  /**
   * Validate migration checksum to detect tampering
   */
  private async validateMigrationChecksum(migration: Migration): Promise<void> {
    try {
      const existingMigration = this.db
        .prepare('SELECT checksum FROM schema_version WHERE version = ?')
        .get(migration.version) as { checksum: string } | undefined;

      if (existingMigration && existingMigration.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} checksum mismatch. ` +
          `Expected: ${existingMigration.checksum}, Got: ${migration.checksum}. ` +
          `Migration file may have been modified after being applied.`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('checksum mismatch')) {
        throw error;
      }
      // If there's an error reading the schema_version table, it's likely the first migration
      // so we can safely continue
    }
  }

  /**
   * Calculate SHA-256 checksum of migration content
   */
  private calculateChecksum(content: string): string {
    return crypto
      .createHash('sha256')
      .update(content.trim())
      .digest('hex');
  }

  /**
   * Validate database integrity after migrations
   */
  public async validateIntegrity(): Promise<boolean> {
    try {
      // Run SQLite integrity check
      const result = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      
      if (result.integrity_check !== 'ok') {
        console.error('❌ Database integrity check failed:', result.integrity_check);
        return false;
      }

      // Verify foreign key constraints
      const fkCheck = this.db.prepare('PRAGMA foreign_key_check').all();
      if (fkCheck.length > 0) {
        console.error('❌ Foreign key constraints violated:', fkCheck);
        return false;
      }

      console.log('✅ Database integrity validated');
      return true;

    } catch (error) {
      console.error('❌ Failed to validate database integrity:', error);
      return false;
    }
  }

  /**
   * Close database connection
   */
  public close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.warn('Warning during database close:', error);
    }
  }

  /**
   * Get database statistics for monitoring
   */
  public getStats(): Record<string, any> {
    try {
      const stats = this.db.prepare('PRAGMA database_list').all();
      const pageCount = this.db.prepare('PRAGMA page_count').get() as { page_count: number };
      const pageSize = this.db.prepare('PRAGMA page_size').get() as { page_size: number };
      const walMode = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };

      return {
        databases: stats,
        totalPages: pageCount.page_count,
        pageSize: pageSize.page_size,
        estimatedSize: pageCount.page_count * pageSize.page_size,
        journalMode: walMode.journal_mode,
        currentVersion: this.getCurrentVersion()
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
} 