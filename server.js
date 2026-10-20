import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

import { CONFIG, assertSafeRestoreTarget } from './src/config.js';
import { FirestoreExporter } from './src/exporter.js';
import { FirestoreRestorer } from './src/restorer.js';
import { IndependentVerifier } from './src/verifier.js';
import { BackupManifest } from './src/manifest.js';
import { exportToJsonTree, exportToCsv, exportToEncryptedBundle } from './src/format_exporters.js';

import { getFirestore } from 'firebase-admin/firestore';

import { computeCanonicalDocumentHash, serializeFirestoreValue } from './src/serializer.js';

import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Favicon handler to prevent 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

const PROJECTS_CONFIG_FILE = path.join(__dirname, 'saved_projects.json');
const SETTINGS_CONFIG_FILE = path.join(__dirname, 'app_settings.json');

// Manage persistent application settings (storage directory, etc.)
async function getAppSettings() {
  try {
    const data = await fs.readFile(SETTINGS_CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return {};
  }
}

async function saveAppSettings(settings) {
  await fs.writeFile(SETTINGS_CONFIG_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

const BASE_DEFAULT_BACKUP_ROOT = process.env.FIRESTORE_BACKUP_DIR || (
  process.platform === 'win32'
    ? path.join(os.homedir(), 'Desktop', 'Firestore_Backups')
    : path.join(__dirname, 'Firestore_Backups')
);

// Retrieve the active storage directory for backups & restores
async function getActiveBackupDirectory() {
  const settings = await getAppSettings();
  if (settings.backupDirectory && typeof settings.backupDirectory === 'string' && settings.backupDirectory.trim()) {
    const dir = settings.backupDirectory.trim();
    // On Linux (Render), ignore Windows drive paths (C:\...) to avoid relative prefixing
    if (process.platform !== 'win32' && /^[a-zA-Z]:[/\\]/.test(dir)) {
      return BASE_DEFAULT_BACKUP_ROOT;
    }
    return path.resolve(dir);
  }
  return BASE_DEFAULT_BACKUP_ROOT;
}

// Manage saved live project connections (NO mock or simulated data)
async function getSavedProjects() {
  try {
    const data = await fs.readFile(PROJECTS_CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (_) {
    return [];
  }
}

async function saveProjects(projects) {
  await fs.writeFile(PROJECTS_CONFIG_FILE, JSON.stringify(projects, null, 2), 'utf8');
}

// Connect strictly to real Firestore via Firebase Admin SDK
function getLiveFirestoreInstance(projectConfig, explicitDbId = null) {
  if (!projectConfig) {
    throw new Error('No database selected. Please connect your Firebase project first.');
  }

  let credentials;
  if (projectConfig.keyJson) {
    credentials = typeof projectConfig.keyJson === 'string' ? JSON.parse(projectConfig.keyJson) : projectConfig.keyJson;
  } else if (projectConfig.keyPath) {
    const raw = fsSync.readFileSync(projectConfig.keyPath, 'utf8');
    credentials = JSON.parse(raw);
  } else {
    throw new Error('Missing Service Account credentials for this project.');
  }

  const projId = projectConfig.projectId || credentials.project_id;
  const appName = `live_app_${projId}_${Date.now()}_${Math.random()}`;
  const appInstance = admin.initializeApp({
    credential: admin.credential.cert(credentials),
    projectId: projId
  }, appName);

  let dbId = explicitDbId || projectConfig.databaseId;
  if (!dbId) {
    try {
      const saved = JSON.parse(fsSync.readFileSync(PROJECTS_CONFIG_FILE, 'utf8'));
      const match = saved.find(p => p.id === projectConfig.id || p.projectId === projId);
      if (match && match.databaseId) {
        dbId = match.databaseId;
      }
    } catch (_) {}
  }

  if (dbId) {
    return getFirestore(appInstance, dbId);
  }
  return appInstance.firestore();
}

// 1. Projects API
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await getSavedProjects();
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, projectId, keyPath, keyJson } = req.body;
    let detectedProjectId = projectId;
    let credentialsObj = null;

    if (keyJson) {
      credentialsObj = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
      detectedProjectId = detectedProjectId || credentialsObj.project_id;
    } else if (keyPath) {
      const raw = await fs.readFile(keyPath, 'utf8');
      credentialsObj = JSON.parse(raw);
      detectedProjectId = detectedProjectId || credentialsObj.project_id;
    } else {
      return res.status(400).json({ error: 'Please provide either a Service Account Key file path or upload the JSON key.' });
    }

    if (!detectedProjectId) {
      return res.status(400).json({ error: 'Could not detect Firebase project_id from key. Please enter project ID manually.' });
    }

    const projects = await getSavedProjects();
    // Check if project already exists
    const existingIdx = projects.findIndex(p => p.projectId === detectedProjectId);

    const projectData = {
      id: `proj_${detectedProjectId}_${Date.now()}`,
      name: (name || detectedProjectId).trim(),
      projectId: detectedProjectId,
      keyPath: keyPath ? keyPath.trim() : null,
      keyJson: keyJson || null
    };

    if (existingIdx !== -1) {
      projects[existingIdx] = projectData;
    } else {
      projects.push(projectData);
    }

    await saveProjects(projects);
    res.json({ success: true, project: projectData, projects });
  } catch (err) {
    res.status(500).json({ error: `Failed to connect Firebase key: ${err.message}` });
  }
});

// Delete a project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    let projects = await getSavedProjects();
    projects = projects.filter(p => p.id !== req.params.id);
    await saveProjects(projects);
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Explore Live Database (Strictly queries real live Firebase Firestore)
app.post('/api/inspect', async (req, res) => {
  try {
    const { project } = req.body;
    if (!project) {
      return res.json({
        success: false,
        notConnected: true,
        error: 'No database connected. Please add your Firebase service account key.'
      });
    }

    let db = getLiveFirestoreInstance(project);
    const resolvedProjId = project.projectId || db._projectId || db.projectId;

    // Real call to Firebase Firestore with automatic fallback for custom/named databases
    let collections;
    try {
      collections = await db.listCollections();
    } catch (listErr) {
      if ((listErr.code === 5 || (listErr.message && listErr.message.includes('NOT_FOUND'))) && !project.databaseId) {
        try {
          const fallbackDb = getLiveFirestoreInstance(project, 'default');
          collections = await fallbackDb.listCollections();
          db = fallbackDb;
          project.databaseId = 'default';
          const allProjects = await getSavedProjects();
          const match = allProjects.find(p => p.id === project.id || p.projectId === project.projectId);
          if (match) {
            match.databaseId = 'default';
            await saveProjects(allProjects);
          }
        } catch (_) {
          throw listErr;
        }
      } else {
        throw listErr;
      }
    }
    const inventory = [];

    for (const coll of collections) {
      // Fetch up to 50 actual live documents from the collection
      const snap = await coll.limit(50).get();
      const docs = [];

      for (const d of snap.docs) {
        let subColls = [];
        try {
          if (typeof d.ref.listCollections === 'function') {
            const sc = await d.ref.listCollections();
            subColls = sc.map(s => s.id);
          }
        } catch (_) {}

        docs.push({
          id: d.id,
          path: d.ref.path,
          subcollections: subColls,
          data: d.data()
        });
      }

      inventory.push({
        id: coll.id,
        path: coll.path,
        count: snap.size,
        docs: docs
      });
    }

    res.json({
      success: true,
      projectId: resolvedProjId,
      collectionsCount: inventory.length,
      collections: inventory,
      recommendation: {
        recommendedFormat: 'jsonl-dr',
        name: 'Full Accuracy Backup (.jsonl)',
        reason: `Recommended for ${resolvedProjId} because Firestore stores native timestamps, null values, and array fields. Full Accuracy Backup ensures 100% of your real data can be restored safely.`
      }
    });
  } catch (err) {
    const projId = req.body?.project?.projectId || 'unknown';
    let friendlyMsg = err.message;
    if (err.code === 5 || (err.message && err.message.includes('NOT_FOUND'))) {
      friendlyMsg = `Firestore Database Not Created Yet (Error 5 NOT_FOUND). The Cloud Firestore database "(default)" has not been created yet in Firebase project "${projId}". To activate it, go to Firebase Console (https://console.firebase.google.com/project/${projId}/firestore) and click "Create database" to choose your region.`;
    }
    res.status(500).json({ error: friendlyMsg, rawError: err.message, code: err.code });
  }
});

// 2b. Fetch Live Subcollection Documents
app.post('/api/subcollection-docs', async (req, res) => {
  try {
    const { project, docPath, subcollectionId } = req.body;
    const db = getLiveFirestoreInstance(project);

    const subcollRef = db.doc(docPath).collection(subcollectionId);
    const snap = await subcollRef.limit(50).get();

    const docs = [];
    for (const d of snap.docs) {
      let subColls = [];
      try {
        if (typeof d.ref.listCollections === 'function') {
          const sc = await d.ref.listCollections();
          subColls = sc.map(s => s.id);
        }
      } catch (_) {}

      docs.push({
        id: d.id,
        path: d.ref.path,
        subcollections: subColls,
        data: d.data()
      });
    }

    res.json({
      success: true,
      docPath,
      subcollectionId,
      fullPath: `${docPath}/${subcollectionId}`,
      count: snap.size,
      docs
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to load subcollection: ${err.message}` });
  }
});

// Storage & Settings APIs: Choose folder on computer for backup and restore files
app.get('/api/settings', async (req, res) => {
  try {
    const currentDir = await getActiveBackupDirectory();
    const settings = await getAppSettings();
    res.json({
      success: true,
      backupDirectory: currentDir,
      defaultBackupDirectory: BASE_DEFAULT_BACKUP_ROOT,
      isCustom: Boolean(settings.backupDirectory && path.resolve(settings.backupDirectory) !== path.resolve(BASE_DEFAULT_BACKUP_ROOT))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { backupDirectory } = req.body;
    if (!backupDirectory || typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
      return res.status(400).json({ error: 'Please provide a valid folder path.' });
    }

    if (process.platform !== 'win32' && /^[a-zA-Z]:[/\\]/.test(backupDirectory.trim())) {
      return res.status(400).json({
        error: `Cannot set a Windows local path ('${backupDirectory.trim()}') on a Linux cloud container (Render). Remote cloud servers cannot write directly to your laptop's C: drive across the internet. To save directly to your laptop's Desktop, run the application locally on your computer at http://localhost:3000, or use the 'Download to PC' / 'Select Backup from Laptop' buttons.`
      });
    }

    const resolved = path.resolve(backupDirectory.trim());

    // Ensure the folder can be created
    await fs.mkdir(resolved, { recursive: true });

    // Test write permissions
    const testFile = path.join(resolved, `.write_test_${Date.now()}`);
    try {
      await fs.writeFile(testFile, 'test', 'utf8');
      await fs.unlink(testFile);
    } catch (permErr) {
      return res.status(400).json({
        error: `Cannot write to folder '${resolved}'. Please check folder permissions: ${permErr.message}`
      });
    }

    const settings = await getAppSettings();
    settings.backupDirectory = resolved;
    await saveAppSettings(settings);

    res.json({
      success: true,
      backupDirectory: resolved,
      message: `Active backup folder successfully set to: ${resolved}`
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to set storage directory: ${err.message}` });
  }
});

app.post('/api/settings/reset', async (req, res) => {
  try {
    const settings = await getAppSettings();
    delete settings.backupDirectory;
    await saveAppSettings(settings);

    await fs.mkdir(BASE_DEFAULT_BACKUP_ROOT, { recursive: true });

    res.json({
      success: true,
      backupDirectory: BASE_DEFAULT_BACKUP_ROOT,
      message: `Storage directory reset to default: ${BASE_DEFAULT_BACKUP_ROOT}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Create Real Live Backup
app.post('/api/backup', async (req, res) => {
  try {
    const { project, format = 'jsonl-dr', passphrase, pauseWrites = false, customBackupRoot } = req.body;
    const db = getLiveFirestoreInstance(project);
    const resolvedProjId = project.projectId || db._projectId || db.projectId;

    const activeBackupRoot = customBackupRoot ? path.resolve(customBackupRoot) : await getActiveBackupDirectory();
    await fs.mkdir(activeBackupRoot, { recursive: true });

    const exporter = new FirestoreExporter(db, {
      backupRoot: activeBackupRoot,
      sourceProjectId: resolvedProjId,
      consistencyClassification: pauseWrites ? 'CONSISTENT_FREEZE_VERIFIED' : 'POTENTIALLY_INCONSISTENT_LIVE_READ',
      consistencyDetails: pauseWrites ? 'App writes were paused during export.' : 'Database was live during export.'
    });

    const baseResult = await exporter.runExport();
    const backupDir = baseResult.backupPath;

    if (format === 'json-tree') {
      const treePath = path.join(backupDir, `${baseResult.backupId}_readable.json`);
      await exportToJsonTree(backupDir, treePath);
    } else if (format === 'csv-flat') {
      const csvDir = path.join(backupDir, 'csv_tables');
      await exportToCsv(backupDir, csvDir);
    } else if (format === 'encrypted-dr') {
      const encPath = path.join(backupDir, `${baseResult.backupId}.enc`);
      await exportToEncryptedBundle(backupDir, encPath, passphrase || 'SecurePass123!');
    }

    res.json({
      success: true,
      backupId: baseResult.backupId,
      backupPath: backupDir,
      formatChosen: format,
      manifest: baseResult.manifest
    });
  } catch (err) {
    res.status(500).json({ error: `Live Backup Failed: ${err.message}` });
  }
});

// 4. Saved Backups
app.get('/api/backups', async (req, res) => {
  try {
    const activeBackupRoot = await getActiveBackupDirectory();
    await fs.mkdir(activeBackupRoot, { recursive: true });
    const entries = await fs.readdir(activeBackupRoot, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const backupDir = path.join(activeBackupRoot, entry.name);
        const manifestPath = path.join(backupDir, 'manifest.json');
        try {
          const manifest = await BackupManifest.loadFromFile(manifestPath);
          const files = await fs.readdir(backupDir);
          const formats = ['jsonl-dr'];
          if (files.some(f => f.endsWith('_readable.json'))) formats.push('json-tree');
          if (files.includes('csv_tables')) formats.push('csv-flat');
          if (files.some(f => f.endsWith('.enc'))) formats.push('encrypted-dr');

          backups.push({
            id: entry.name,
            path: backupDir,
            manifest: manifest.toJSON(),
            availableFormats: formats
          });
        } catch (_) {}
      }
    }

    backups.sort((a, b) => (b.manifest.startedAt || '').localeCompare(a.manifest.startedAt || ''));
    res.json({ success: true, count: backups.length, backups, activeBackupDirectory: activeBackupRoot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. Download Backup File Directly to User's Local Machine
app.get('/api/backups/download/:backupId', async (req, res) => {
  try {
    const { backupId } = req.params;
    const activeBackupRoot = await getActiveBackupDirectory();
    const backupDir = path.join(activeBackupRoot, backupId);

    try {
      await fs.access(backupDir);
    } catch (_) {
      return res.status(404).json({ error: `Backup '${backupId}' not found on server.` });
    }

    const dataDir = path.join(backupDir, 'data');
    let files = [];
    try {
      files = await fs.readdir(dataDir);
    } catch (_) {}

    const jsonlFile = files.find(f => f.endsWith('.jsonl'));
    if (jsonlFile) {
      const fullPath = path.join(dataDir, jsonlFile);
      res.setHeader('Content-Disposition', `attachment; filename="${backupId}.jsonl"`);
      res.setHeader('Content-Type', 'application/x-ndjson');
      return fsSync.createReadStream(fullPath).pipe(res);
    }

    const rootFiles = await fs.readdir(backupDir);
    const jsonFile = rootFiles.find(f => f.endsWith('.json') && f !== 'manifest.json');
    if (jsonFile) {
      const fullPath = path.join(backupDir, jsonFile);
      res.setHeader('Content-Disposition', `attachment; filename="${jsonFile}"`);
      res.setHeader('Content-Type', 'application/json');
      return fsSync.createReadStream(fullPath).pipe(res);
    }

    const manifestPath = path.join(backupDir, 'manifest.json');
    res.setHeader('Content-Disposition', `attachment; filename="${backupId}_manifest.json"`);
    res.setHeader('Content-Type', 'application/json');
    return fsSync.createReadStream(manifestPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. Upload Backup File from User's Local Computer (for Restore or Inspection)
app.post('/api/backups/upload', async (req, res) => {
  try {
    const { fileName, content, sourceProject } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'No backup file content provided.' });
    }

    const activeBackupRoot = await getActiveBackupDirectory();
    await fs.mkdir(activeBackupRoot, { recursive: true });

    const cleanName = (fileName || 'local_backup').replace(/[^a-zA-Z0-9_-]/g, '_');
    const backupId = `laptop_${cleanName}_${Date.now()}`;
    const backupDir = path.join(activeBackupRoot, backupId);
    const dataDir = path.join(backupDir, 'data');

    await fs.mkdir(dataDir, { recursive: true });

    let rawRecords = [];
    const trimmed = content.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsedArr = JSON.parse(trimmed);
        if (Array.isArray(parsedArr)) {
          rawRecords = parsedArr;
        }
      } catch (_) {}
    }

    if (rawRecords.length === 0) {
      const rawLines = trimmed.split('\n').filter(l => l.trim().length > 0);
      for (let i = 0; i < rawLines.length; i++) {
        try {
          const parsed = JSON.parse(rawLines[i]);
          rawRecords.push(parsed);
        } catch (_) {}
      }
    }

    if (rawRecords.length === 0) {
      return res.status(400).json({ error: 'The uploaded file does not contain valid JSON or JSONL Firestore records.' });
    }

    const normalizedLines = [];
    const docHashes = {};
    const collectionsSet = new Set();

    for (let i = 0; i < rawRecords.length; i++) {
      const raw = rawRecords[i];
      const docPath = raw.path || (raw.id ? `imported_collection/${raw.id}` : `imported_collection/doc_${i + 1}`);
      const docId = raw.id || docPath.split('/').pop();
      const docData = raw.data !== undefined ? raw.data : (raw.fields || raw);

      const segments = docPath.split('/');
      if (segments.length >= 2) {
        collectionsSet.add(segments[0]);
      }

      const canonicalHash = computeCanonicalDocumentHash(docPath, docData);
      const record = {
        path: docPath,
        id: docId,
        data: docData,
        canonicalHash: canonicalHash,
        exportedAt: raw.exportedAt || new Date().toISOString()
      };

      docHashes[docPath] = canonicalHash;
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
      sourceProject: sourceProject || 'user-laptop',
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
        totalCollections: collectionsSet.size || 1
      }
    };

    await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');

    res.json({
      success: true,
      backupId,
      backupPath: backupDir,
      documentCount: normalizedLines.length,
      manifest: manifestData
    });
  } catch (err) {
    res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
});

// 5. Verify Backup
app.post('/api/verify', async (req, res) => {
  try {
    const { backupDir } = req.body;
    if (!backupDir) throw new Error('Please select a backup directory.');
    const report = await IndependentVerifier.verifyBackupArtifact(backupDir);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Inspect Contents of Saved Backup File Directly (Hierarchical Firebase Console view)
app.post('/api/backup-content', async (req, res) => {
  try {
    const { backupDir } = req.body;
    if (!backupDir) throw new Error('Please select a backup directory.');

    const manifestPath = path.join(backupDir, 'manifest.json');
    const manifest = await BackupManifest.loadFromFile(manifestPath);

    const dataDir = path.join(backupDir, 'data');
    let files = [];
    try {
      files = await fs.readdir(dataDir);
    } catch (_) {}

    const readlineModule = (await import('readline')).default;
    const fsStream = (await import('fs'));

    const rootCollections = {};

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const absPath = path.join(dataDir, f);

      const rl = readlineModule.createInterface({
        input: fsStream.createReadStream(absPath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        const parts = record.path.split('/');

        if (parts.length === 2) {
          // Top-level document: coll/docId
          const [collId, docId] = parts;
          if (!rootCollections[collId]) {
            rootCollections[collId] = { id: collId, path: collId, docs: {} };
          }
          if (!rootCollections[collId].docs[docId]) {
            rootCollections[collId].docs[docId] = {
              id: docId,
              path: record.path,
              data: record.data,
              subcollections: record.subcollections || [],
              subcollectionData: {}
            };
          } else {
            rootCollections[collId].docs[docId].data = record.data;
            if (record.subcollections && record.subcollections.length > 0) {
              rootCollections[collId].docs[docId].subcollections = record.subcollections;
            }
          }
        } else if (parts.length === 4) {
          // Subcollection document: coll/docId/subColl/subDocId
          const [collId, docId, subCollId, subDocId] = parts;
          if (!rootCollections[collId]) {
            rootCollections[collId] = { id: collId, path: collId, docs: {} };
          }
          if (!rootCollections[collId].docs[docId]) {
            rootCollections[collId].docs[docId] = {
              id: docId,
              path: `${collId}/${docId}`,
              data: {},
              subcollections: [subCollId],
              subcollectionData: {}
            };
          }
          if (!rootCollections[collId].docs[docId].subcollections.includes(subCollId)) {
            rootCollections[collId].docs[docId].subcollections.push(subCollId);
          }
          if (!rootCollections[collId].docs[docId].subcollectionData[subCollId]) {
            rootCollections[collId].docs[docId].subcollectionData[subCollId] = [];
          }
          rootCollections[collId].docs[docId].subcollectionData[subCollId].push({
            id: subDocId,
            path: record.path,
            data: record.data
          });
        }
      }
    }

    const collectionsList = [];
    for (const [collId, info] of Object.entries(rootCollections)) {
      const docsArray = [];
      for (const [docId, docInfo] of Object.entries(info.docs)) {
        docsArray.push({
          id: docId,
          path: docInfo.path,
          data: docInfo.data,
          subcollections: docInfo.subcollections || [],
          subcollectionData: docInfo.subcollectionData || {}
        });
      }
      docsArray.sort((a, b) => a.id.localeCompare(b.id));

      collectionsList.push({
        id: collId,
        path: collId,
        count: docsArray.length,
        docs: docsArray
      });
    }

    collectionsList.sort((a, b) => a.id.localeCompare(b.id));

    res.json({
      success: true,
      backupId: manifest.backupId,
      sourceProject: manifest.sourceProject,
      startedAt: manifest.startedAt,
      totalDocuments: manifest.stats?.totalDocuments || Object.keys(manifest.documentHashes).length,
      collectionsCount: collectionsList.length,
      collections: collectionsList
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to read backup contents: ${err.message}` });
  }
});

// 6. Restore: Dry Run
app.post('/api/restore/dry-run', async (req, res) => {
  try {
    const { backupDir, destProject, allowOverwrite, conflictMode = 'skip' } = req.body;
    const destDb = getLiveFirestoreInstance(destProject);
    const targetProjId = destProject.projectId || destDb._projectId || destDb.projectId;

    assertSafeRestoreTarget(targetProjId);

    const restorer = new FirestoreRestorer(destDb, targetProjId, {
      dryRun: true,
      conflictMode: conflictMode || (allowOverwrite ? 'overwrite' : 'skip'),
      allowOverwrite: conflictMode === 'overwrite' || allowOverwrite === true,
      remapProject: true
    });

    const result = await restorer.runRestore(backupDir);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Restore: Execute
app.post('/api/restore/execute', async (req, res) => {
  try {
    const { backupDir, destProject, allowOverwrite, conflictMode = 'skip', confirm } = req.body;
    if (!confirm) {
      throw new Error('Please check the confirmation box to authorize restoring data to this database.');
    }

    const destDb = getLiveFirestoreInstance(destProject);
    const targetProjId = destProject.projectId || destDb._projectId || destDb.projectId;

    assertSafeRestoreTarget(targetProjId);

    const restorer = new FirestoreRestorer(destDb, targetProjId, {
      dryRun: false,
      conflictMode: conflictMode || (allowOverwrite ? 'overwrite' : 'skip'),
      allowOverwrite: conflictMode === 'overwrite' || allowOverwrite === true,
      remapProject: true
    });

    const result = await restorer.runRestore(backupDir);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Restore: Verify
app.post('/api/restore/verify', async (req, res) => {
  try {
    const { backupDir, destProject } = req.body;
    const destDb = getLiveFirestoreInstance(destProject);
    const targetProjId = destProject.projectId || destDb._projectId || destDb.projectId;

    const audit = await IndependentVerifier.verifyRestoredDestination(backupDir, destDb, {
      remapProject: true
    });

    res.json({ success: true, audit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[REAL FIRESTORE BACKUP APP] Running at http://localhost:${PORT}`);
});
