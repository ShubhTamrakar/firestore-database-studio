import path from 'path';
import os from 'os';

export const CONFIG = {
  SCHEMA_VERSION: '2.0-universal',
  TOOL_VERSION: '2.0.0',
  DEFAULT_BATCH_SIZE: 400,
  MAX_RETRY_ATTEMPTS: 5,
  INITIAL_RETRY_DELAY_MS: 1000,
  // Dedicated local folder on computer for storing backups
  DEFAULT_BACKUP_ROOT: process.env.FIRESTORE_BACKUP_DIR || path.join(os.homedir(), 'Desktop', 'Firestore_Backups')
};

/**
 * Universal project validator:
 * Ensures destination project is specified and confirmed.
 */
export function assertSafeRestoreTarget(targetProjectId, options = {}) {
  if (!targetProjectId || targetProjectId.trim() === '') {
    throw new Error('Please select or specify a destination project for restoration.');
  }
}
