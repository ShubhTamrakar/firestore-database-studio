import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { computeFileSha256 } from './manifest.js';

export class GoogleDriveBackupManager {
  /**
   * Initializes Google Drive client using a service account or OAuth credentials.
   * Credentials path must be passed at runtime or loaded from environment; never hardcoded.
   */
  constructor(credentialsPath, targetFolderId = null) {
    if (!credentialsPath) {
      throw new Error('Google Drive credentials path is required. Provide path to service account key file.');
    }
    this.credentialsPath = credentialsPath;
    this.targetFolderId = targetFolderId;
    this.drive = null;
  }

  async authenticate() {
    const auth = new google.auth.GoogleAuth({
      keyFile: this.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
    });
    this.drive = google.drive({ version: 'v3', auth });
    return this.drive;
  }

  async uploadBackup(backupDirPath, folderName = null) {
    if (!this.drive) {
      await this.authenticate();
    }

    const backupBaseName = folderName || path.basename(backupDirPath);

    // Create a folder on Google Drive for this specific backup
    const folderMetadata = {
      name: backupBaseName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: this.targetFolderId ? [this.targetFolderId] : []
    };

    const folderRes = await this.drive.files.create({
      resource: folderMetadata,
      fields: 'id, name'
    });

    const remoteBackupFolderId = folderRes.data.id;
    const uploadedFilesReport = [];

    // Recursively upload all files in backupDir
    const filesToUpload = await this.collectFiles(backupDirPath);

    for (const relFilePath of filesToUpload) {
      const absFilePath = path.join(backupDirPath, relFilePath);
      const localSha256 = await computeFileSha256(absFilePath);

      // Create file in remote folder
      const fileMetadata = {
        name: relFilePath.replace(/[\/\\]/g, '__'),
        parents: [remoteBackupFolderId]
      };

      const media = {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(absFilePath)
      };

      const uploaded = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, md5Checksum, size'
      });

      uploadedFilesReport.push({
        path: relFilePath,
        fileId: uploaded.data.id,
        localSha256,
        remoteMd5: uploaded.data.md5Checksum,
        size: uploaded.data.size
      });
    }

    return {
      success: true,
      remoteFolderId: remoteBackupFolderId,
      backupId: backupBaseName,
      filesUploaded: uploadedFilesReport.length,
      files: uploadedFilesReport,
      retentionAdvice: 'LOCAL BACKUP RETAINED. Never delete local backup upon upload completion.',
      failureDomainRisk: 'CRITICAL AUDIT NOTICE: If Google Drive and Firestore reside under the same Google Workspace/GCP identity root, they share an administrative failure domain. Maintain a geographically and administratively isolated offline copy for true disaster resilience.'
    };
  }

  async collectFiles(dir, base = dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await this.collectFiles(fullPath, base));
      } else {
        files.push(path.relative(base, fullPath));
      }
    }
    return files;
  }
}
