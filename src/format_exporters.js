import fs from 'fs/promises';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { serializeFirestoreValue, deserializeFirestoreValue } from './serializer.js';

/**
 * Multi-Format Backup Generators
 */

// 1. JSON Tree Format Exporter (Single or multi-file nested JSON tree)
export async function exportToJsonTree(backupDir, targetFilePath) {
  const dataDir = path.join(backupDir, 'data');
  const files = await fs.readdir(dataDir);
  const tree = {};

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const absPath = path.join(dataDir, file);
    const rl = readline.createInterface({
      input: createReadStream(absPath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const parts = record.path.split('/');
      let current = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = current[parts[i]] || {};
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = record.data;
    }
  }

  await fs.writeFile(targetFilePath, JSON.stringify(tree, null, 2), 'utf8');
  return targetFilePath;
}

// 2. CSV Flat Exporter (Flattens top-level documents into CSV files per collection)
export async function exportToCsv(backupDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const dataDir = path.join(backupDir, 'data');
  const files = await fs.readdir(dataDir);
  const generatedCsvFiles = [];

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const absPath = path.join(dataDir, file);
    const collName = file.replace('.jsonl', '').replace(/__/g, '_');
    const csvPath = path.join(targetDir, `${collName}.csv`);

    const records = [];
    const headers = new Set(['__doc_id', '__doc_path']);

    const rl = readline.createInterface({
      input: createReadStream(absPath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const flat = flattenObject(record.data);
      flat['__doc_id'] = record.id;
      flat['__doc_path'] = record.path;
      for (const k of Object.keys(flat)) {
        headers.add(k);
      }
      records.push(flat);
    }

    const headerList = Array.from(headers);
    let csvContent = headerList.map(escapeCsvValue).join(',') + '\n';

    for (const r of records) {
      const row = headerList.map(h => escapeCsvValue(r[h] !== undefined ? r[h] : ''));
      csvContent += row.join(',') + '\n';
    }

    await fs.writeFile(csvPath, csvContent, 'utf8');
    generatedCsvFiles.push(csvPath);
  }

  return generatedCsvFiles;
}

// 3. AES-256-GCM Encrypted Bundle Exporter
export async function exportToEncryptedBundle(backupDir, targetEncryptedFilePath, passphrase) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Encryption passphrase must be at least 8 characters.');
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Read manifest and all data files into an uncompressed archive buffer
  const manifestContent = await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8');
  const dataFiles = await fs.readdir(path.join(backupDir, 'data'));
  const archive = {
    manifest: JSON.parse(manifestContent),
    data: {}
  };

  for (const f of dataFiles) {
    archive.data[f] = await fs.readFile(path.join(backupDir, 'data', f), 'utf8');
  }

  const plaintextBuffer = Buffer.from(JSON.stringify(archive), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const finalPackage = {
    version: '1.0-aes256gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64')
  };

  await fs.writeFile(targetEncryptedFilePath, JSON.stringify(finalPackage, null, 2), 'utf8');
  return targetEncryptedFilePath;
}

// Decrypt AES-256-GCM Bundle
export async function decryptEncryptedBundle(encryptedFilePath, targetExtractedDir, passphrase) {
  const content = await fs.readFile(encryptedFilePath, 'utf8');
  const pkg = JSON.parse(content);

  const salt = Buffer.from(pkg.salt, 'base64');
  const iv = Buffer.from(pkg.iv, 'base64');
  const authTag = Buffer.from(pkg.authTag, 'base64');
  const ciphertext = Buffer.from(pkg.ciphertext, 'base64');

  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const archive = JSON.parse(decrypted.toString('utf8'));

  await fs.mkdir(targetExtractedDir, { recursive: true });
  await fs.writeFile(path.join(targetExtractedDir, 'manifest.json'), JSON.stringify(archive.manifest, null, 2), 'utf8');

  const dataDir = path.join(targetExtractedDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });

  for (const [filename, fileContent] of Object.entries(archive.data)) {
    await fs.writeFile(path.join(dataDir, filename), fileContent, 'utf8');
  }

  return targetExtractedDir;
}

function flattenObject(ob, prefix = '', result = {}) {
  for (const i in ob) {
    if (!Object.prototype.hasOwnProperty.call(ob, i)) continue;
    const propName = prefix ? prefix + '.' + i : i;
    if (ob[i] && typeof ob[i] === 'object' && !Array.isArray(ob[i]) && !ob[i].__fs_type__) {
      flattenObject(ob[i], propName, result);
    } else {
      result[propName] = typeof ob[i] === 'object' ? JSON.stringify(ob[i]) : ob[i];
    }
  }
  return result;
}

function escapeCsvValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
