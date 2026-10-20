import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { FirestoreExporter, retryWithBackoff, ExportError } from '../src/exporter.js';
import { IndependentVerifier } from '../src/verifier.js';
import { MockFirestore } from './mock_firestore.js';

test('Failure Mode: Permission Denied aborts immediately and never treats inaccessible collections as empty', async () => {
  const mockDb = new MockFirestore('eternalbloom-de253');
  // Mock permission error on listCollections
  mockDb.listCollections = async () => {
    const err = new Error('Missing or insufficient permissions');
    err.code = 7; // PERMISSION_DENIED
    throw err;
  };

  const exporter = new FirestoreExporter(mockDb, {
    backupRoot: os.tmpdir(),
    sourceProjectId: 'eternalbloom-de253'
  });

  await assert.rejects(
    async () => await exporter.runExport(),
    (err) => {
      assert.ok(err instanceof ExportError);
      assert.ok(err.message.includes('Permission denied'));
      assert.ok(err.message.includes('Inaccessible paths are never treated as empty'));
      return true;
    }
  );
});

test('Failure Mode: Quota Exhausted aborts safely without infinite retry loop', async () => {
  let callCount = 0;
  const mockFn = async () => {
    callCount++;
    const err = new Error('Resource exhausted: Quota exceeded for quota metric');
    err.code = 8; // RESOURCE_EXHAUSTED
    throw err;
  };

  await assert.rejects(
    async () => await retryWithBackoff(mockFn, 'quota test operation', 5),
    (err) => {
      assert.ok(err instanceof ExportError);
      assert.ok(err.message.includes('quota exhausted'));
      return true;
    }
  );

  assert.equal(callCount, 1, 'Quota error must immediately halt without burning retries');
});

test('Failure Mode: Process crash / unfinalized staging directory is never marked valid', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr_crash_test_'));
  const incompleteBackupDir = path.join(tempDir, 'backup_eternalbloom-de253_crashed');
  await fs.mkdir(incompleteBackupDir, { recursive: true });

  // Missing manifest.json
  await assert.rejects(
    async () => await IndependentVerifier.verifyBackupArtifact(incompleteBackupDir),
    /Failed to load manifest/
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('Failure Mode: Document in manifest missing from data files is detected', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr_manifest_gap_'));
  const backupDir = path.join(tempDir, 'backup_test');
  const dataDir = path.join(backupDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });

  const dummyFile = path.join(dataDir, 'dummy.jsonl');
  await fs.writeFile(dummyFile, '', 'utf8');

  const { computeFileSha256 } = await import('../src/manifest.js');
  const sha = await computeFileSha256(dummyFile);

  const manifestData = {
    schemaVersion: '1.0-dr',
    toolVersion: '1.0.0',
    backupId: 'backup_test',
    sourceProject: 'test-proj',
    sourceDatabase: '(default)',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    consistencyClassification: 'CONSISTENT_FREEZE_VERIFIED',
    stats: { totalCollections: 1, totalDocuments: 1, totalFiles: 1 },
    collections: [{ path: 'products', subcollections: [] }],
    files: { 'data/dummy.jsonl': { sha256: sha, sizeBytes: 0, docCount: 0 } },
    documentHashes: {
      'products/phantom_doc': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    },
    exclusions: [],
    errors: [],
    warnings: []
  };

  await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

  const report = await IndependentVerifier.verifyBackupArtifact(backupDir);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(e => e.includes('phantom_doc') && e.includes('missing from all backup data files')));

  await fs.rm(tempDir, { recursive: true, force: true });
});
