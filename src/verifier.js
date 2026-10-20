import fs from 'fs/promises';
import readline from 'readline';
import { createReadStream } from 'fs';
import path from 'path';
import { BackupManifest, computeFileSha256 } from './manifest.js';
import { computeCanonicalDocumentHash, deserializeFirestoreValue } from './serializer.js';

export class VerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VerificationError';
    this.details = details;
  }
}

/**
 * Deep semantic equality comparison between two Firestore values.
 * Handles Timestamps (seconds & nanoseconds), GeoPoints (latitude & longitude),
 * Buffers/Bytes, DocumentReferences, Arrays, Objects, and primitives.
 */
export function deepSemanticCompare(expected, actual, pathTrace = '') {
  const differences = [];

  if (expected === actual) return differences;

  if (expected === null || actual === null || expected === undefined || actual === undefined) {
    if (expected !== actual) {
      differences.push({ path: pathTrace, expected, actual, reason: 'Null/undefined mismatch' });
    }
    return differences;
  }

  // Handle Buffer comparison
  if (Buffer.isBuffer(expected) || Buffer.isBuffer(actual)) {
    if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(actual) || !expected.equals(actual)) {
      differences.push({ path: pathTrace, reason: 'Buffer/Bytes mismatch', expected: expected ? expected.toString('base64') : null, actual: actual ? actual.toString('base64') : null });
    }
    return differences;
  }

  // Handle Firestore Timestamp comparison
  if (typeof expected.toMillis === 'function' || typeof actual.toMillis === 'function') {
    const expSec = expected.seconds !== undefined ? expected.seconds : Math.floor(expected.toMillis() / 1000);
    const expNano = expected.nanoseconds !== undefined ? expected.nanoseconds : (expected.toMillis() % 1000) * 1000000;
    const actSec = actual.seconds !== undefined ? actual.seconds : Math.floor(actual.toMillis() / 1000);
    const actNano = actual.nanoseconds !== undefined ? actual.nanoseconds : (actual.toMillis() % 1000) * 1000000;

    if (expSec !== actSec || expNano !== actNano) {
      differences.push({ path: pathTrace, reason: 'Timestamp precision mismatch', expected: { seconds: expSec, nanoseconds: expNano }, actual: { seconds: actSec, nanoseconds: actNano } });
    }
    return differences;
  }

  // Handle GeoPoint comparison
  if ((expected.latitude !== undefined && expected.longitude !== undefined) ||
      (actual.latitude !== undefined && actual.longitude !== undefined)) {
    if (expected.latitude !== actual.latitude || expected.longitude !== actual.longitude) {
      differences.push({ path: pathTrace, reason: 'GeoPoint coordinates mismatch', expected: { lat: expected.latitude, lng: expected.longitude }, actual: { lat: actual.latitude, lng: actual.longitude } });
    }
    return differences;
  }

  // Handle DocumentReference comparison
  if (expected.path && (expected.firestore || expected.isDocumentReference) &&
      actual.path && (actual.firestore || actual.isDocumentReference)) {
    if (expected.path !== actual.path) {
      differences.push({ path: pathTrace, reason: 'DocumentReference path mismatch', expected: expected.path, actual: actual.path });
    }
    return differences;
  }

  // Handle Arrays
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      differences.push({ path: pathTrace, reason: 'Array length mismatch', expectedLength: Array.isArray(expected) ? expected.length : 'not an array', actualLength: Array.isArray(actual) ? actual.length : 'not an array' });
      return differences;
    }
    for (let i = 0; i < expected.length; i++) {
      const childDiffs = deepSemanticCompare(expected[i], actual[i], `${pathTrace}[${i}]`);
      differences.push(...childDiffs);
    }
    return differences;
  }

  // Handle Objects
  if (typeof expected === 'object' && typeof actual === 'object') {
    const expKeys = Object.keys(expected).sort();
    const actKeys = Object.keys(actual).sort();

    // Check missing or extra keys
    for (const key of expKeys) {
      if (!(key in actual)) {
        differences.push({ path: `${pathTrace}.${key}`, reason: 'Missing key in actual object' });
      } else {
        const childDiffs = deepSemanticCompare(expected[key], actual[key], `${pathTrace}.${key}`);
        differences.push(...childDiffs);
      }
    }
    for (const key of actKeys) {
      if (!(key in expected)) {
        differences.push({ path: `${pathTrace}.${key}`, reason: 'Unexpected extra key in actual object' });
      }
    }
    return differences;
  }

  // Primitives
  if (expected !== actual) {
    differences.push({ path: pathTrace, reason: 'Primitive value mismatch', expected, actual });
  }

  return differences;
}

export class IndependentVerifier {
  /**
   * Phase 1: Verify local backup files, SHA-256 file hashes,
   * document JSONL records, and canonical SHA-256 document hashes.
   */
  static async verifyBackupArtifact(backupDir) {
    const manifestPath = path.join(backupDir, 'manifest.json');
    let manifest;
    try {
      manifest = await BackupManifest.loadFromFile(manifestPath);
    } catch (err) {
      throw new VerificationError(`Failed to load manifest at '${manifestPath}': ${err.message}`, { cause: err });
    }

    const errors = [];
    const warnings = [];
    const verifiedDocs = new Set();

    // 1. Verify file-level SHA-256 checksums from manifest
    for (const [relPath, fileMeta] of Object.entries(manifest.files)) {
      const absPath = path.join(backupDir, relPath);
      try {
        const actualSha256 = await computeFileSha256(absPath);
        if (actualSha256 !== fileMeta.sha256) {
          errors.push(`File SHA-256 mismatch for '${relPath}'. Expected ${fileMeta.sha256}, calculated ${actualSha256}`);
        }
      } catch (err) {
        errors.push(`File missing or unreadable '${relPath}': ${err.message}`);
        continue;
      }

      // 2. Parse JSONL lines and verify canonical document hashes
      let lineNum = 0;
      const rl = readline.createInterface({
        input: createReadStream(absPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        lineNum++;
        if (!line.trim()) continue;

        let record;
        try {
          record = JSON.parse(line);
        } catch (err) {
          errors.push(`Malformed JSON at '${relPath}' line ${lineNum}: ${err.message}`);
          continue;
        }

        if (!record.path || !record.id || record.data === undefined) {
          errors.push(`Invalid record structure at '${relPath}' line ${lineNum}: missing path, id, or data.`);
          continue;
        }

        if (verifiedDocs.has(record.path)) {
          errors.push(`Duplicate document path '${record.path}' detected in backup.`);
        }
        verifiedDocs.add(record.path);

        const computedCanonicalHash = computeCanonicalDocumentHash(record.path, record.data);
        if (computedCanonicalHash !== record.canonicalHash) {
          errors.push(`Document canonical hash corruption at '${record.path}'. Stored: ${record.canonicalHash}, computed: ${computedCanonicalHash}`);
        }

        const manifestExpectedHash = manifest.documentHashes[record.path];
        if (!manifestExpectedHash) {
          errors.push(`Document '${record.path}' exists in data file '${relPath}' but is missing from manifest documentHashes inventory.`);
        } else if (manifestExpectedHash !== computedCanonicalHash) {
          errors.push(`Manifest hash mismatch for '${record.path}'. Manifest: ${manifestExpectedHash}, record: ${computedCanonicalHash}`);
        }
      }
    }

    // 3. Check for documents in manifest that were not found in files
    for (const expectedDocPath of Object.keys(manifest.documentHashes)) {
      if (!verifiedDocs.has(expectedDocPath)) {
        errors.push(`Document '${expectedDocPath}' recorded in manifest but missing from all backup data files.`);
      }
    }

    const isValid = errors.length === 0;
    return {
      valid: isValid,
      backupId: manifest.backupId,
      totalDocumentsExpected: manifest.totalDocuments,
      totalDocumentsVerified: verifiedDocs.size,
      errors,
      warnings
    };
  }

  /**
   * Phase 2: Post-restoration independent deep semantic audit.
   * Reads the destination Firestore project documents and field-by-field verifies them against the backup.
   */
  static async verifyRestoredDestination(backupDir, destinationFirestoreDb, options = {}) {
    const manifestPath = path.join(backupDir, 'manifest.json');
    const manifest = await BackupManifest.loadFromFile(manifestPath);

    const backupDocPaths = new Set(Object.keys(manifest.documentHashes));
    const backupCollectionPaths = new Set(
      manifest.collections ? manifest.collections.map(c => c.path) : []
    );

    const report = {
      success: true,
      backupId: manifest.backupId,
      destinationProjectId: destinationFirestoreDb._projectId || destinationFirestoreDb.projectId || 'unknown',
      totalDocumentsChecked: 0,
      totalDestinationDocumentsScanned: 0,
      totalMismatches: 0,
      missingDocuments: [],
      fieldMismatches: [],
      extraDocuments: [],
      extraCollections: [],
      emptyCollectionsInDestination: [],
      isExactOneToOneMatch: true
    };

    // 1. Forward Audit: Backup -> Destination Firestore
    // Verify every document in backup exists in destination and matches field-by-field
    for (const relPath of Object.keys(manifest.files)) {
      const absPath = path.join(backupDir, relPath);
      const rl = readline.createInterface({
        input: createReadStream(absPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        report.totalDocumentsChecked++;

        const docRef = destinationFirestoreDb.doc(record.path);
        const snapshot = await docRef.get();

        if (!snapshot.exists) {
          if (record.exists) {
            report.missingDocuments.push(record.path);
            report.totalMismatches++;
            report.success = false;
          }
          continue;
        }

        const actualData = snapshot.data();
        const expectedData = deserializeFirestoreValue(record.data, destinationFirestoreDb, {
          remapProject: options.remapProject !== false
        });

        const diffs = deepSemanticCompare(expectedData, actualData, record.path);
        if (diffs.length > 0) {
          report.fieldMismatches.push({
            path: record.path,
            differences: diffs
          });
          report.totalMismatches += diffs.length;
          report.success = false;
        }
      }
    }

    // 2. Reverse Audit: Destination Firestore -> Backup
    // Scan destination to detect extra collections, subcollections, or documents not in backup
    const scannedDocPaths = new Set();
    const scannedCollPaths = new Set();

    async function scanDestinationRecursively(collRef) {
      const collPath = collRef.path;
      scannedCollPaths.add(collPath);

      // Check if collection was known in backup
      const isKnownInBackup = backupCollectionPaths.has(collPath) ||
        Array.from(backupDocPaths).some(p => p.startsWith(collPath + '/'));

      if (!isKnownInBackup) {
        report.extraCollections.push(collPath);
      }

      let docRefs = [];
      try {
        docRefs = await collRef.listDocuments();
      } catch (_) {
        // If listDocuments fails, fallback to get()
        try {
          const snap = await collRef.get();
          docRefs = snap.docs.map(d => d.ref);
        } catch (_) {}
      }

      if (docRefs.length === 0) {
        report.emptyCollectionsInDestination.push(collPath);
      }

      for (const docRef of docRefs) {
        const docPath = docRef.path;
        if (scannedDocPaths.has(docPath)) continue;
        scannedDocPaths.add(docPath);
        report.totalDestinationDocumentsScanned++;

        if (!backupDocPaths.has(docPath)) {
          try {
            const snap = await docRef.get();
            if (snap.exists) {
              report.extraDocuments.push(docPath);
            }
          } catch (_) {}
        }

        // Recursively inspect any subcollections under this document
        try {
          const subColls = await docRef.listCollections();
          for (const subColl of subColls) {
            await scanDestinationRecursively(subColl);
          }
        } catch (_) {}
      }
    }

    try {
      const topLevelCollections = await destinationFirestoreDb.listCollections();
      for (const collRef of topLevelCollections) {
        await scanDestinationRecursively(collRef);
      }
    } catch (scanErr) {
      report.reverseScanNote = `Reverse scan partial or skipped: ${scanErr.message}`;
    }

    if (report.extraDocuments.length > 0 || report.extraCollections.length > 0) {
      report.isExactOneToOneMatch = false;
    } else {
      report.isExactOneToOneMatch = report.success;
    }

    return report;
  }
}
