import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { IndependentVerifier } from '../src/verifier.js';
import { computeCanonicalDocumentHash } from '../src/serializer.js';

test('Local Bridge: Upload from local laptop generates valid, verified backup manifest', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laptop-backup-test-'));

  try {
    const rawContent = [
      JSON.stringify({ path: 'users/alice', id: 'alice', data: { name: 'Alice', age: 30 } }),
      JSON.stringify({ path: 'users/bob', id: 'bob', data: { name: 'Bob', age: 25 } })
    ].join('\n');

    // Simulate upload handler logic
    const backupId = `laptop_test_${Date.now()}`;
    const backupDir = path.join(tmpDir, backupId);
    const dataDir = path.join(backupDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    const lines = rawContent.split('\n');
    const normalizedLines = [];
    const docHashes = {};

    for (const line of lines) {
      const raw = JSON.parse(line);
      const canonicalHash = computeCanonicalDocumentHash(raw.path, raw.data);
      const record = {
        path: raw.path,
        id: raw.id,
        data: raw.data,
        canonicalHash: canonicalHash,
        exportedAt: new Date().toISOString()
      };
      docHashes[raw.path] = canonicalHash;
      normalizedLines.push(JSON.stringify(record));
    }

    const outputContent = normalizedLines.join('\n') + '\n';
    const dataFilePath = path.join(dataDir, 'data.jsonl');
    await fs.writeFile(dataFilePath, outputContent, 'utf8');

    const crypto = await import('crypto');
    const fileHash = crypto.createHash('sha256').update(outputContent, 'utf8').digest('hex');
    const fileBytes = Buffer.byteLength(outputContent, 'utf8');

    const manifestData = {
      schemaVersion: '2.0-universal',
      toolVersion: '2.0.0',
      backupId: backupId,
      sourceProject: 'user-laptop',
      sourceDatabase: '(default)',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      consistencyClassification: 'CONSISTENT_FREEZE_VERIFIED',
      consistencyDetails: 'Imported from user laptop/computer local storage.',
      totalDocuments: normalizedLines.length,
      files: {
        'data/data.jsonl': {
          sha256: fileHash,
          sizeBytes: fileBytes,
          bytes: fileBytes,
          docCount: normalizedLines.length,
          documentCount: normalizedLines.length
        }
      },
      documentHashes: docHashes,
      stats: {
        totalDocuments: normalizedLines.length,
        totalCollections: 1
      }
    };

    await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

    // Verify using IndependentVerifier
    const verification = await IndependentVerifier.verifyBackupArtifact(backupDir);
    assert.equal(verification.valid, true, 'Uploaded backup artifact must pass verification');
    assert.equal(verification.errors.length, 0, 'Must have zero verification errors');
    assert.equal(verification.totalDocumentsVerified, 2, 'Must verify all documents');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
