/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports -- electron-updater types unavailable in web build, all autoUpdater usage is conditional */
/**
 * UpdaterService - Wraps electron-updater's autoUpdater for OTA updates.
 *
 * Forwards update lifecycle events to the renderer via IPC.
 * Auto-download is disabled so users must confirm before downloading.
 *
 * When running outside Electron (standalone web server), all methods are no-ops.
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { UpdaterStatus } from '@shared/types';

const logger = createLogger('UpdaterService');

// Conditional import — electron-updater is only available in Electron builds
let autoUpdater: any = null;

try {
  const electronUpdater = require('electron-updater');
  autoUpdater = electronUpdater.autoUpdater;
} catch {
  logger.info('electron-updater not available — update checks disabled');
}

export class UpdaterService {
  private mainWindow: unknown = null;

  constructor() {
    if (autoUpdater) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      this.bindEvents();
    }
  }

  setMainWindow(window: unknown): void {
    this.mainWindow = window;
  }

  async checkForUpdates(): Promise<void> {
    if (!autoUpdater) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.error('Check for updates failed:', getErrorMessage(error));
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!autoUpdater) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger.error('Download update failed:', getErrorMessage(error));
    }
  }

  quitAndInstall(): void {
    if (!autoUpdater) return;
    autoUpdater.quitAndInstall(true, true);
  }

  private sendStatus(status: UpdaterStatus): void {
    const win = this.mainWindow as any;
    if (win && !win.isDestroyed?.()) {
      win.webContents?.send('updater:status', status);
    }
  }

  private bindEvents(): void {
    if (!autoUpdater) return;

    autoUpdater.on('checking-for-update', () => {
      logger.info('Checking for update...');
      this.sendStatus({ type: 'checking' });
    });

    autoUpdater.on('update-available', (info: any) => {
      logger.info('Update available:', info.version);
      this.sendStatus({
        type: 'available',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      });
    });

    autoUpdater.on('update-not-available', () => {
      logger.info('No update available');
      this.sendStatus({ type: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress: any) => {
      this.sendStatus({
        type: 'downloading',
        progress: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    autoUpdater.on('update-downloaded', (info: any) => {
      logger.info('Update downloaded:', info.version);
      this.sendStatus({
        type: 'downloaded',
        version: info.version,
      });
    });

    autoUpdater.on('error', (error: any) => {
      logger.error('Updater error:', getErrorMessage(error));
      this.sendStatus({
        type: 'error',
        error: getErrorMessage(error),
      });
    });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports -- re-enable after conditional electron-updater imports */
