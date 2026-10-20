import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { FirestoreExporter, ExportError } from '../src/exporter.js';
import { FirestoreRestorer, RestoreError } from '../src/restorer.js';
import { IndependentVerifier } from '../src/verifier.js';
import { MockFirestore, MockTimestamp, MockGeoPoint, MockDocumentReference } from './mock_firestore.js';

test('Full DR Lifecycle: Export, Tampering Detection, Safety Guards, Dry Run, Restore & Deep Audit', async (t) => {
  const tempTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr_test_'));

  // 1. Populate rich synthetic database
  const sourceDb = new MockFirestore('eternalbloom-de253');
  const destDb = new MockFirestore('novatalk-d6c58');

  // Categories
  sourceDb._setDocDirect('categories/cat_electronics', {
    name: 'Electronics ⚡',
    active: true,
    sortOrder: 1,
    metadata: { tags: ['tech', 'gadgets'], priority: 10 }
  });

  // Products with subcollections
  const catRef = new MockDocumentReference('categories/cat_electronics', sourceDb);
  sourceDb._setDocDirect('products/prod_laptop_001', {
    title: 'Precision Workstation X1',
    categoryRef: catRef,
    price: 1999.99,
    inStock: true,
    warehouseLocation: new MockGeoPoint(37.422, -122.084),
    binarySignature: Buffer.from('FIRMWARE_SHA_TEST_SIGNATURE', 'utf8'),
    manufacturingTime: new MockTimestamp(1710000000, 500000000),
    tags: ['workstation', 'enterprise']
  });

  // Empty document test
  sourceDb._setDocDirect('products/prod_empty_placeholder', {});

  // Deeply nested subcollection
  sourceDb._setDocDirect('products/prod_laptop_001/variants/v_16gb_512gb', {
    sku: 'SKU-16-512',
    ramGb: 16,
    storageGb: 512
  });

  sourceDb._setDocDirect('products/prod_laptop_001/variants/v_16gb_512gb/reviews/rev_user_99', {
    author: 'Alice QA',
    rating: 5,
    comment: 'Flawless performance with unicode: 🚀 💻'
  });

  // Settings
  sourceDb._setDocDirect('settings/general_config', {
    maintenanceMode: false,
    version: '2.4.0',
    nullField: null
  });

  // 2. Execute Recursive Export
  const exporter = new FirestoreExporter(sourceDb, {
    backupRoot: tempTestDir,
    batchSize: 2, // force multiple batch pages
    consistencyClassification: 'CONSISTENT_FREEZE_VERIFIED',
    sourceProjectId: 'eternalbloom-de253'
  });

  const exportResult = await exporter.runExport();
  assert.ok(exportResult.success);
  assert.equal(exportResult.manifest.stats.totalDocuments, 6);
  const backupDir = exportResult.backupPath;

  // 3. Verify Backup Artifact with Independent Verifier
  const verifyReport = await IndependentVerifier.verifyBackupArtifact(backupDir);
  assert.ok(verifyReport.valid, 'Backup artifact should pass independent validation');
  assert.equal(verifyReport.totalDocumentsVerified, 6);
  assert.equal(verifyReport.errors.length, 0);

  // 4. Test Failure Injection: File Tampering Detection
  const files = await fs.readdir(path.join(backupDir, 'data'));
  const firstDataFile = path.join(backupDir, 'data', files[0]);
  const originalFileContent = await fs.readFile(firstDataFile, 'utf8');

  // Inject a 1-character mutation
  await fs.writeFile(firstDataFile, originalFileContent.replace('Electronics', 'TamperedElectronics'), 'utf8');

  const tamperedReport = await IndependentVerifier.verifyBackupArtifact(backupDir);
  assert.equal(tamperedReport.valid, false, 'Verifier must fail upon file tampering');
  assert.ok(tamperedReport.errors.some(e => e.includes('SHA-256 mismatch') || e.includes('Document canonical hash corruption')));

  // Restore pristine file
  await fs.writeFile(firstDataFile, originalFileContent, 'utf8');
  const restoredPristineReport = await IndependentVerifier.verifyBackupArtifact(backupDir);
  assert.ok(restoredPristineReport.valid, 'Pristine file passes verification again');

  // 5. Test Safety Lock: Rejection of Empty Target Destination
  assert.throws(() => {
    new FirestoreRestorer(sourceDb, '');
  }, /Please select or specify a destination project/);

  // 7. Test Dry Run Restoration
  const dryRestorer = new FirestoreRestorer(destDb, 'novatalk-d6c58', {
    dryRun: true,
    ledgerDir: path.join(tempTestDir, 'ledgers')
  });

  const dryRunResult = await dryRestorer.runRestore(backupDir);
  assert.ok(dryRunResult.success);
  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.totalProcessed, 6);
  // Assert destination is still empty!
  assert.equal(destDb._docs.size, 0, 'Dry run must not write any documents to destination');

  // 8. Test Overwrite Prevention
  // Artificially plant a document in destination
  destDb._setDocDirect('categories/cat_electronics', { conflict: 'existing_data' });

  const safeRestorer = new FirestoreRestorer(destDb, 'novatalk-d6c58', {
    dryRun: false,
    allowOverwrite: false,
    ledgerDir: path.join(tempTestDir, 'ledgers')
  });

  await assert.rejects(
    async () => await safeRestorer.runRestore(backupDir),
    /already exists in destination project/
  );

  // 9. Execute Real Bounded-Batch Restoration with Overwrite Allowed
  const activeRestorer = new FirestoreRestorer(destDb, 'novatalk-d6c58', {
    dryRun: false,
    allowOverwrite: true,
    batchSize: 2, // test multi-batch commits
    remapProject: true,
    ledgerDir: path.join(tempTestDir, 'ledgers')
  });

  const restoreResult = await activeRestorer.runRestore(backupDir);
  assert.ok(restoreResult.success);
  assert.equal(restoreResult.totalProcessed, 6);
  assert.equal(destDb._docs.size, 6);

  // 10. Run Post-Restore Independent Deep Semantic Audit
  const auditReport = await IndependentVerifier.verifyRestoredDestination(backupDir, destDb, {
    remapProject: true
  });

  assert.ok(auditReport.success, 'Post-restore deep audit must succeed 100%');
  assert.equal(auditReport.totalDocumentsChecked, 6);
  assert.equal(auditReport.totalMismatches, 0);

  // Clean up temp directory
  await fs.rm(tempTestDir, { recursive: true, force: true });
});
