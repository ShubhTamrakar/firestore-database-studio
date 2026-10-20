#!/usr/bin/env node
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import { CONFIG, assertSafeRestoreTarget } from './config.js';
import { FirestoreExporter } from './exporter.js';
import { IndependentVerifier } from './verifier.js';
import { FirestoreRestorer } from './restorer.js';
import { GoogleDriveBackupManager } from './gdrive.js';

function printHelp() {
  console.log(`
Firestore Zero-Data-Loss Disaster Recovery CLI
Version: ${CONFIG.TOOL_VERSION} (Schema ${CONFIG.SCHEMA_VERSION})

Commands:
  inventory --key=<path> [--project=<id>]
      Perform read-only discovery of collections and document counts.

  export --key=<path> [--project=<id>] [--out=<dir>] [--consistency=freeze|live]
      Discover, serialize, and package an immutable backup with SHA-256 manifests.

  verify-backup --backup-dir=<dir>
      Independently verify all file hashes, JSONL records, and canonical doc hashes.

  dry-run-restore --key=<path> --dest-project=<id> --backup-dir=<dir>
      Simulate restoration to target project; verify integrity and check existing collisions.

  restore --key=<path> --dest-project=<id> --backup-dir=<dir> [--allow-overwrite] [--confirm]
      Execute bounded-batch restoration to allowed destination project (e.g. ${CONFIG.TEST_PROJECT_ID}).

  verify-restore --key=<path> --dest-project=<id> --backup-dir=<dir>
      Deep semantic field-by-field audit of destination database against backup.

  upload-drive --gdrive-key=<path> --backup-dir=<dir> [--folder-id=<id>]
      Upload backup to Google Drive and verify remote checksums.
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const params = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        params[key] = val;
      } else {
        const key = arg.slice(2);
        params[key] = true;
      }
    }
  }

  return { command, params };
}

function initFirestore(serviceAccountPath, projectId) {
  if (!serviceAccountPath) {
    throw new Error('Service account key path (--key=<path>) is required.');
  }

  // Load service account JSON cleanly
  const keyContent = JSON.parse(fsSync.readFileSync(serviceAccountPath, 'utf8'));
  const app = admin.initializeApp({
    credential: admin.credential.cert(keyContent),
    projectId: projectId || keyContent.project_id
  }, `app_${Date.now()}_${Math.random()}`);

  return app.firestore();
}

async function main() {
  const { command, params } = parseArgs();

  if (!command || command === 'help' || params.help) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'inventory': {
        const db = initFirestore(params.key, params.project);
        const collections = await db.listCollections();
        console.log(`\n=== FIRESTORE READ-ONLY INVENTORY: ${params.project || 'default'} ===`);
        console.log(`Discovered ${collections.length} top-level collections:`);
        for (const coll of collections) {
          const snapshot = await coll.limit(5).get();
          console.log(` - Collection: [${coll.id}] (sample read: ${snapshot.size} docs)`);
        }
        break;
      }

      case 'export': {
        const db = initFirestore(params.key, params.project);
        const consistency = params.consistency === 'freeze' ? 'CONSISTENT_FREEZE_VERIFIED' : 'POTENTIALLY_INCONSISTENT_LIVE_READ';
        const exporter = new FirestoreExporter(db, {
          backupRoot: params.out || CONFIG.DEFAULT_BACKUP_ROOT,
          consistencyClassification: consistency,
          consistencyDetails: consistency === 'CONSISTENT_FREEZE_VERIFIED' ? 'Maintenance window asserted.' : 'Live read. Skew possible.',
          sourceProjectId: params.project || db.projectId,
          onProgress: (p) => console.log(`[EXPORT] [${p.stage}]`, p.message || p.collection || p.backupId || '')
        });
        const result = await exporter.runExport();
        console.log('\n=== EXPORT COMPLETED SUCCESSFULLY ===');
        console.log(`Backup ID:   ${result.backupId}`);
        console.log(`Location:    ${result.backupPath}`);
        console.log(`Total Docs:  ${result.manifest.stats.totalDocuments}`);
        console.log(`Consistency: ${result.manifest.consistencyClassification}`);
        break;
      }

      case 'verify-backup': {
        if (!params['backup-dir']) throw new Error('--backup-dir is required');
        console.log(`\n=== INDEPENDENT BACKUP INTEGRITY VERIFICATION ===`);
        const report = await IndependentVerifier.verifyBackupArtifact(params['backup-dir']);
        if (report.valid) {
          console.log(`STATUS: PASS (100% verified across ${report.totalDocumentsVerified} documents)`);
        } else {
          console.error(`STATUS: FAILED (${report.errors.length} integrity errors detected)`);
          report.errors.forEach(e => console.error(`  - ${e}`));
          process.exitCode = 1;
        }
        break;
      }

      case 'dry-run-restore': {
        assertSafeRestoreTarget(params['dest-project']);
        const db = initFirestore(params.key, params['dest-project']);
        const restorer = new FirestoreRestorer(db, params['dest-project'], {
          dryRun: true,
          allowOverwrite: params['allow-overwrite'] === true,
          onProgress: (p) => console.log(`[DRY-RUN RESTORE] [${p.stage}]`, p.message || '')
        });
        const res = await restorer.runRestore(params['backup-dir']);
        console.log(`\n=== DRY RUN COMPLETED (0 database mutations executed) ===`);
        console.log(`Documents evaluated: ${res.totalProcessed}`);
        console.log(`Ledger written:      ${res.ledgerFile}`);
        break;
      }

      case 'restore': {
        assertSafeRestoreTarget(params['dest-project']);
        if (!params.confirm) {
          throw new Error('Safety guard: --confirm flag is required to execute real writes to destination.');
        }
        const db = initFirestore(params.key, params['dest-project']);
        const restorer = new FirestoreRestorer(db, params['dest-project'], {
          dryRun: false,
          allowOverwrite: params['allow-overwrite'] === true,
          onProgress: (p) => console.log(`[RESTORE] [${p.stage}]`, p.countCommitted ? `Committed ${p.countCommitted} docs` : (p.message || ''))
        });
        const res = await restorer.runRestore(params['backup-dir']);
        console.log(`\n=== RESTORATION COMPLETED ===`);
        console.log(`Target:              ${params['dest-project']}`);
        console.log(`Documents restored:  ${res.totalProcessed}`);
        console.log(`Ledger written:      ${res.ledgerFile}`);
        break;
      }

      case 'verify-restore': {
        assertSafeRestoreTarget(params['dest-project']);
        const db = initFirestore(params.key, params['dest-project']);
        console.log(`\n=== POST-RESTORE INDEPENDENT DEEP AUDIT ===`);
        const audit = await IndependentVerifier.verifyRestoredDestination(params['backup-dir'], db);
        if (audit.success) {
          console.log(`AUDIT RESULT: 100% MATCH across ${audit.totalDocumentsChecked} documents.`);
        } else {
          console.error(`AUDIT RESULT: MISMATCHES DETECTED (${audit.totalMismatches} discrepancies)`);
          console.error(JSON.stringify(audit, null, 2));
          process.exitCode = 1;
        }
        break;
      }

      case 'upload-drive': {
        if (!params['gdrive-key'] || !params['backup-dir']) {
          throw new Error('--gdrive-key and --backup-dir are required');
        }
        const manager = new GoogleDriveBackupManager(params['gdrive-key'], params['folder-id']);
        const res = await manager.uploadBackup(params['backup-dir']);
        console.log(`\n=== GOOGLE DRIVE BACKUP COPY COMPLETED ===`);
        console.log(`Drive Folder ID: ${res.remoteFolderId}`);
        console.log(`Files uploaded:  ${res.filesUploaded}`);
        console.log(res.retentionAdvice);
        console.log(res.failureDomainRisk);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n[FATAL ERROR] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exitCode = 1;
  }
}

main();
