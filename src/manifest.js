import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from './config.js';

export async function computeFileSha256(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class BackupManifest {
  constructor(options = {}) {
    this.backupId = options.backupId || `backup_${options.sourceProject || 'firestore'}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.schemaVersion = CONFIG.SCHEMA_VERSION;
    this.toolVersion = CONFIG.TOOL_VERSION;
    this.sourceProject = options.sourceProject || null;
    this.sourceDatabase = options.sourceDatabase || '(default)';
    this.startedAt = options.startedAt || new Date().toISOString();
    this.completedAt = null;
    this.consistencyClassification = options.consistencyClassification || 'POTENTIALLY_INCONSISTENT_LIVE_READ';
    this.consistencyDetails = options.consistencyDetails || 'Sequential live read. Write-freeze was not asserted.';
    this.collections = options.collections || [];
    this.files = options.files || {}; // relativeFilePath -> { sha256, sizeBytes, docCount }
    this.documentHashes = options.documentHashes || {}; // docPath -> canonicalSha256
    this.totalDocuments = options.totalDocuments || (options.stats ? options.stats.totalDocuments : 0) || Object.keys(this.documentHashes).length;
    this.exclusions = [
      'Firestore Security Rules (firestore.rules) - requires CLI/Firebase console export',
      'Composite & Single-field Index configurations (firestore.indexes.json) - requires CLI export',
      'Firebase Authentication User accounts - requires firebase auth:export',
      'Cloud Storage buckets & files - requires gsutil/Cloud Storage export',
      'Cloud Functions code and state'
    ];
    this.errors = [];
    this.warnings = [];
  }

  addCollection(collPath, subcollections = []) {
    if (!this.collections.find(c => c.path === collPath)) {
      this.collections.push({
        path: collPath,
        subcollections: subcollections
      });
    }
  }

  recordDocument(docPath, canonicalHash) {
    this.documentHashes[docPath] = canonicalHash;
    this.totalDocuments++;
  }

  async recordFile(relativeFilePath, absoluteFilePath, docCount = 0) {
    const stats = await fs.stat(absoluteFilePath);
    const sha256 = await computeFileSha256(absoluteFilePath);
    this.files[relativeFilePath] = {
      sha256,
      sizeBytes: stats.size,
      docCount
    };
  }

  finalize(completedAt = new Date().toISOString()) {
    this.completedAt = completedAt;
  }

  toJSON() {
    const docCount = this.totalDocuments || Object.keys(this.documentHashes).length;
    return {
      schemaVersion: this.schemaVersion,
      toolVersion: this.toolVersion,
      backupId: this.backupId,
      sourceProject: this.sourceProject,
      sourceDatabase: this.sourceDatabase,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      consistencyClassification: this.consistencyClassification,
      consistencyDetails: this.consistencyDetails,
      stats: {
        totalCollections: this.collections.length,
        totalDocuments: docCount,
        totalFiles: Object.keys(this.files).length
      },
      collections: this.collections,
      files: this.files,
      documentHashes: this.documentHashes,
      exclusions: this.exclusions,
      errors: this.errors,
      warnings: this.warnings
    };
  }

  async writeToFile(manifestPath) {
    const jsonStr = JSON.stringify(this.toJSON(), null, 2);
    await fs.writeFile(manifestPath, jsonStr, 'utf8');
  }

  static async loadFromFile(manifestPath) {
    const content = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    const manifest = new BackupManifest(parsed);
    Object.assign(manifest, parsed);
    return manifest;
  }
}
