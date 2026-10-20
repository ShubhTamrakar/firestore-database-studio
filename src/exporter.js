import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from './config.js';
import { serializeFirestoreValue, computeCanonicalDocumentHash, SerializationError } from './serializer.js';
import { BackupManifest } from './manifest.js';

export class ExportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExportError';
    this.details = details;
  }
}

/**
 * Robust retry wrapper with exponential backoff.
 * Halts immediately on non-transient permission or quota errors.
 */
export async function retryWithBackoff(fn, operationDesc, maxRetries = CONFIG.MAX_RETRY_ATTEMPTS) {
  let attempt = 0;
  let delay = CONFIG.INITIAL_RETRY_DELAY_MS;

  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const code = err.code || (err.status ? String(err.status) : null);
      const msg = err.message || '';

      // Check for hard permission denial (gRPC 7: PERMISSION_DENIED)
      if (code === 7 || code === '7' || msg.includes('PERMISSION_DENIED') || msg.includes('Missing or insufficient permissions')) {
        throw new ExportError(`HARD ERROR: Permission denied during '${operationDesc}'. Discovery halted. Inaccessible paths are never treated as empty.`, { cause: err });
      }

      // Check for quota exhaustion (gRPC 8: RESOURCE_EXHAUSTED / 429)
      if (code === 8 || code === '8' || code === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded')) {
        throw new ExportError(`HARD ERROR: Firestore quota exhausted during '${operationDesc}'. Stopping safely to prevent quota loops.`, { cause: err });
      }

      if (attempt >= maxRetries) {
        throw new ExportError(`Exceeded maximum retry attempts (${maxRetries}) for '${operationDesc}': ${msg}`, { cause: err, attempts: attempt });
      }

      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * 200);
      const sleepTime = delay + jitter;
      await new Promise(resolve => setTimeout(resolve, sleepTime));
      delay *= 2;
    }
  }
}

export class FirestoreExporter {
  constructor(firestoreDb, options = {}) {
    this.db = firestoreDb;
    this.options = {
      backupRoot: options.backupRoot || CONFIG.DEFAULT_BACKUP_ROOT,
      batchSize: options.batchSize || CONFIG.DEFAULT_BATCH_SIZE,
      consistencyClassification: options.consistencyClassification || 'POTENTIALLY_INCONSISTENT_LIVE_READ',
      consistencyDetails: options.consistencyDetails || 'Sequential live read. Write-freeze was not asserted.',
      onProgress: options.onProgress || (() => {}),
      sourceProjectId: options.sourceProjectId || (firestoreDb._projectId || firestoreDb.projectId || 'unknown'),
      sourceDatabaseId: options.sourceDatabaseId || '(default)',
      ...options
    };
  }

  async runExport() {
    const startedAt = new Date().toISOString();
    const backupId = `backup_${this.options.sourceProjectId}_${startedAt.replace(/[:.]/g, '-')}`;
    const stagingDir = path.join(this.options.backupRoot, `.staging_${backupId}`);
    const finalDir = path.join(this.options.backupRoot, backupId);

    // Ensure target destination does not already exist
    try {
      await fs.access(finalDir);
      throw new ExportError(`Backup directory '${finalDir}' already exists. Overwrite prohibited.`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.mkdir(stagingDir, { recursive: true });
    const dataDir = path.join(stagingDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    const manifest = new BackupManifest({
      backupId,
      sourceProject: this.options.sourceProjectId,
      sourceDatabase: this.options.sourceDatabaseId,
      startedAt,
      consistencyClassification: this.options.consistencyClassification,
      consistencyDetails: this.options.consistencyDetails
    });

    try {
      this.options.onProgress({ stage: 'discovery_started', message: 'Discovering top-level collections...' });

      // List all top-level collections
      const topLevelCollections = await retryWithBackoff(
        () => this.db.listCollections(),
        'list top-level collections'
      );

      const collectionIds = topLevelCollections.map(c => c.id);
      this.options.onProgress({
        stage: 'collections_discovered',
        count: collectionIds.length,
        collections: collectionIds
      });

      for (const collRef of topLevelCollections) {
        await this.exportCollectionRecursively(collRef, stagingDir, dataDir, manifest);
      }

      // Finalize manifest
      manifest.finalize();
      const manifestPath = path.join(stagingDir, 'manifest.json');
      await manifest.writeToFile(manifestPath);

      // Record manifest file checksum in manifest itself is circular,
      // but we compute a separate checksums.txt
      const filesInStaging = await this.listAllFilesRelative(stagingDir);
      let checksumsTxt = '';
      for (const relFile of filesInStaging) {
        const absFile = path.join(stagingDir, relFile);
        const { computeFileSha256 } = await import('./manifest.js');
        const hash = await computeFileSha256(absFile);
        checksumsTxt += `${hash}  ${relFile}\n`;
      }
      await fs.writeFile(path.join(stagingDir, 'checksums.sha256'), checksumsTxt, 'utf8');

      // Atomic rename from staging to final
      await fs.rename(stagingDir, finalDir);

      this.options.onProgress({
        stage: 'export_completed',
        backupId,
        finalDir,
        totalDocs: manifest.totalDocuments
      });

      return {
        success: true,
        backupId,
        backupPath: finalDir,
        manifest: manifest.toJSON()
      };
    } catch (err) {
      // Clean up staging on failure
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch (_) {}
      throw err;
    }
  }

  async exportCollectionRecursively(collRef, stagingDir, dataDir, manifest) {
    const collPath = collRef.path;
    const safeCollFileName = collPath.replace(/[\/\\]/g, '__') + '.jsonl';
    const relativeDataFilePath = path.join('data', safeCollFileName);
    const absDataFilePath = path.join(dataDir, safeCollFileName);

    let docCountInColl = 0;
    const discoveredSubcollections = new Set();
    const writeStream = (await import('fs')).createWriteStream(absDataFilePath, { flags: 'w', encoding: 'utf8' });

    let lastDocSnapshot = null;
    let hasMore = true;

    while (hasMore) {
      let query = collRef.limit(this.options.batchSize);
      if (lastDocSnapshot) {
        query = query.startAfter(lastDocSnapshot);
      }

      const snapshot = await retryWithBackoff(
        () => query.get(),
        `query collection page '${collPath}'`
      );

      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      for (const docSnapshot of snapshot.docs) {
        docCountInColl++;
        const docPath = docSnapshot.ref.path;
        const exists = docSnapshot.exists;
        const rawData = exists ? docSnapshot.data() : {};

        // Discover subcollections on this document
        const subColls = await retryWithBackoff(
          () => docSnapshot.ref.listCollections(),
          `list subcollections of '${docPath}'`
        );

        for (const subColl of subColls) {
          discoveredSubcollections.add(subColl.id);
        }

        const serializedData = serializeFirestoreValue(rawData);
        const canonicalHash = computeCanonicalDocumentHash(docPath, serializedData);

        const record = {
          path: docPath,
          id: docSnapshot.id,
          exists: exists,
          subcollections: subColls.map(sc => sc.id),
          canonicalHash,
          createTime: docSnapshot.createTime ? { seconds: docSnapshot.createTime.seconds, nanoseconds: docSnapshot.createTime.nanoseconds } : null,
          updateTime: docSnapshot.updateTime ? { seconds: docSnapshot.updateTime.seconds, nanoseconds: docSnapshot.updateTime.nanoseconds } : null,
          data: serializedData
        };

        writeStream.write(JSON.stringify(record) + '\n');
        manifest.recordDocument(docPath, canonicalHash);

        // Recurse into subcollections
        for (const subColl of subColls) {
          await this.exportCollectionRecursively(subColl, stagingDir, dataDir, manifest);
        }
      }

      if (snapshot.docs.length < this.options.batchSize) {
        hasMore = false;
      } else {
        lastDocSnapshot = snapshot.docs[snapshot.docs.length - 1];
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => err ? reject(err) : resolve());
    });

    manifest.addCollection(collPath, Array.from(discoveredSubcollections));
    await manifest.recordFile(relativeDataFilePath, absDataFilePath, docCountInColl);

    this.options.onProgress({
      stage: 'collection_exported',
      collection: collPath,
      documentCount: docCountInColl
    });
  }

  async listAllFilesRelative(dir, base = dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await this.listAllFilesRelative(fullPath, base));
      } else {
        files.push(path.relative(base, fullPath));
      }
    }
    return files;
  }
}
