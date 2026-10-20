import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import { CONFIG, assertSafeRestoreTarget } from './config.js';
import { deserializeFirestoreValue } from './serializer.js';
import { BackupManifest } from './manifest.js';
import { IndependentVerifier } from './verifier.js';
import { retryWithBackoff } from './exporter.js';

export class RestoreError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RestoreError';
    this.details = details;
  }
}

export class FirestoreRestorer {
  constructor(firestoreDb, destinationProjectId, options = {}) {
    this.db = firestoreDb;
    this.destinationProjectId = destinationProjectId;
    this.options = {
      batchSize: options.batchSize || CONFIG.DEFAULT_BATCH_SIZE,
      dryRun: options.dryRun !== false, // Defaults to TRUE for safety!
      conflictMode: options.conflictMode || (options.allowOverwrite ? 'overwrite' : 'skip'),
      allowOverwrite: options.conflictMode === 'overwrite' || options.allowOverwrite === true,
      remapProject: options.remapProject !== false,
      ledgerDir: options.ledgerDir || path.join(CONFIG.DEFAULT_BACKUP_ROOT, 'ledgers'),
      onProgress: options.onProgress || (() => {}),
      ...options
    };

    // Strict project assertion
    assertSafeRestoreTarget(this.destinationProjectId);
  }

  async runRestore(backupDir) {
    const startedAt = new Date().toISOString();

    // Step 1: Pre-flight Independent Integrity Verification
    this.options.onProgress({ stage: 'preflight_verification', message: 'Verifying backup artifact integrity before restoration...' });
    const verification = await IndependentVerifier.verifyBackupArtifact(backupDir);
    if (!verification.valid) {
      throw new RestoreError(`Pre-flight backup verification failed with ${verification.errors.length} errors. Restoration aborted.`, { errors: verification.errors });
    }

    const manifestPath = path.join(backupDir, 'manifest.json');
    const manifest = await BackupManifest.loadFromFile(manifestPath);

    await fs.mkdir(this.options.ledgerDir, { recursive: true });
    const ledgerFile = path.join(
      this.options.ledgerDir,
      `restore_ledger_${manifest.backupId}_${startedAt.replace(/[:.]/g, '-')}.json`
    );

    const ledger = {
      backupId: manifest.backupId,
      sourceProject: manifest.sourceProject,
      destinationProjectId: this.destinationProjectId,
      isFreshClone: false,
      dryRun: this.options.dryRun,
      conflictMode: this.options.conflictMode,
      allowOverwrite: this.options.allowOverwrite,
      startedAt,
      completedAt: null,
      totalPlanned: manifest.totalDocuments || Object.keys(manifest.documentHashes).length,
      attempted: [],
      inserted: [],
      skipped: [],
      overwritten: [],
      completed: [],
      overwritesBlocked: [],
      errors: []
    };

    try {
      // Check if destination database is fresh & empty
      let existingCollections = [];
      try {
        existingCollections = await retryWithBackoff(
          () => this.db.listCollections(),
          'list destination collections'
        );
      } catch (_) {}

      ledger.isFreshClone = existingCollections.length === 0;

      this.options.onProgress({
        stage: 'restore_plan',
        isFreshClone: ledger.isFreshClone,
        dryRun: this.options.dryRun,
        conflictMode: this.options.conflictMode,
        totalPlanned: ledger.totalPlanned,
        message: ledger.isFreshClone
          ? `Target database '${this.destinationProjectId}' is completely fresh and empty. Perfect for full database cloning!`
          : `Target database '${this.destinationProjectId}' already has ${existingCollections.length} collections (Conflict mode: ${this.options.conflictMode}).`
      });

      // Step 2: Iterate through all backup records
      let currentBatch = this.db.batch();
      let currentBatchCount = 0;
      let totalProcessed = 0;

      for (const relPath of Object.keys(manifest.files)) {
        const absPath = path.join(backupDir, relPath);
        const rl = readline.createInterface({
          input: createReadStream(absPath, { encoding: 'utf8' }),
          crlfDelay: Infinity
        });

        for await (const line of rl) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          const docPath = record.path;
          ledger.attempted.push(docPath);

          // Step 3: Check if destination document already exists
          const docRef = this.db.doc(docPath);
          const existingSnap = await retryWithBackoff(
            () => docRef.get(),
            `check existing doc '${docPath}'`
          );

          if (existingSnap.exists) {
            if (this.options.conflictMode === 'skip') {
              // SKIP EXISTING: Only restore missing documents that are not already present!
              ledger.skipped.push(docPath);
              totalProcessed++;
              continue;
            } else if (this.options.conflictMode === 'abort') {
              ledger.overwritesBlocked.push(docPath);
              throw new RestoreError(
                `SAFETY ABORT: Document '${docPath}' already exists in destination project '${this.destinationProjectId}'. ` +
                `Choose "Skip existing documents" to only restore missing data, or "Overwrite matching documents".`,
                { docPath }
              );
            } else {
              // 'overwrite'
              ledger.overwritten.push(docPath);
            }
          } else {
            ledger.inserted.push(docPath);
          }

          if (record.exists) {
            const deserializedData = deserializeFirestoreValue(record.data, this.db, {
              remapProject: this.options.remapProject,
              TimestampClass: this.db.constructor.Timestamp,
              GeoPointClass: this.db.constructor.GeoPoint
            });

            if (!this.options.dryRun) {
              currentBatch.set(docRef, deserializedData);
              currentBatchCount++;
            }
          }

          totalProcessed++;

          // Commit bounded batch
          if (!this.options.dryRun && currentBatchCount >= this.options.batchSize) {
            const batchToCommit = currentBatch;
            currentBatch = this.db.batch();
            const countCommitted = currentBatchCount;
            currentBatchCount = 0;

            await retryWithBackoff(
              () => batchToCommit.commit(),
              `commit batch of ${countCommitted} documents`
            );

            ledger.completed.push(...ledger.attempted.slice(ledger.completed.length, totalProcessed));
            this.options.onProgress({
              stage: 'batch_committed',
              countCommitted,
              totalProcessed
            });
          }
        }
      }

      // Commit any remaining items in final batch
      if (!this.options.dryRun && currentBatchCount > 0) {
        await retryWithBackoff(
          () => currentBatch.commit(),
          `commit final batch of ${currentBatchCount} documents`
        );
        ledger.completed.push(...ledger.attempted.slice(ledger.completed.length, totalProcessed));
      }

      ledger.completedAt = new Date().toISOString();
      await fs.writeFile(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');

      this.options.onProgress({
        stage: 'restore_complete',
        dryRun: this.options.dryRun,
        totalProcessed,
        ledgerFile
      });

      return {
        success: true,
        dryRun: this.options.dryRun,
        conflictMode: this.options.conflictMode,
        totalPlanned: ledger.totalPlanned,
        totalProcessed,
        totalInserted: ledger.inserted.length,
        totalSkipped: ledger.skipped.length,
        totalOverwritten: ledger.overwritten.length,
        ledgerFile,
        ledger
      };
    } catch (err) {
      ledger.errors.push({ error: err.message, stack: err.stack });
      ledger.completedAt = new Date().toISOString();
      try {
        await fs.writeFile(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
      } catch (_) {}
      throw err;
    }
  }
}
