/**
 * Session Settings for NanoClaw
 * Bootstraps Claude session configuration including PostToolUse hooks
 * for tool call observability.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * Bootstrap the Claude session settings directory for a group.
 * Creates the settings.json file with hook configuration.
 * Returns the host path to the session directory.
 *
 * IMPORTANT: This must be called BEFORE spawning the CLI process
 * so hooks are in place when the agent starts.
 */
export function bootstrapSessionSettings(groupFolder: string): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hooksDir = path.join(process.cwd(), 'container', 'hooks');
  const toolObserverHook = path.join(hooksDir, 'tool-observer.sh');

  const defaultSettings: Record<string, unknown> = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };

  // Build hooks configuration
  const hooks: Record<string, unknown[]> = {};

  if (fs.existsSync(toolObserverHook)) {
    // Verify execute permissions — fix if missing
    try {
      fs.accessSync(toolObserverHook, fs.constants.X_OK);
    } catch {
      log.warn('tool-observer.sh missing execute permission, fixing', {
        path: toolObserverHook,
      });
      try {
        fs.chmodSync(toolObserverHook, 0o755);
      } catch (chmodErr) {
        log.error('Failed to set execute permission on tool-observer.sh', {
          err: chmodErr,
        });
      }
    }

    const toolObserverEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: toolObserverHook }],
    };
    hooks.PostToolUse = [toolObserverEntry];
    hooks.PostToolUseFailure = [toolObserverEntry];
  }

  if (Object.keys(hooks).length > 0) {
    defaultSettings.hooks = hooks;
  }

  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(defaultSettings, null, 2) + '\n',
    );
    log.info('Session settings created', { group: groupFolder });
  } else {
    // Ensure existing settings have hooks up to date
    try {
      const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      let needsWrite = false;
      if (!existing.hooks && defaultSettings.hooks) {
        existing.hooks = defaultSettings.hooks;
        needsWrite = true;
      } else if (existing.hooks && defaultSettings.hooks) {
        const desired = defaultSettings.hooks as Record<string, unknown[]>;
        for (const [hookType, entries] of Object.entries(desired)) {
          if (!existing.hooks[hookType]) {
            existing.hooks[hookType] = entries;
            needsWrite = true;
          } else {
            const existingJson = JSON.stringify(existing.hooks[hookType]);
            const desiredJson = JSON.stringify(entries);
            if (existingJson !== desiredJson) {
              existing.hooks[hookType] = entries;
              needsWrite = true;
            }
          }
        }
      }
      if (needsWrite) {
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(existing, null, 2) + '\n',
        );
        log.info('Session settings updated with hooks', { group: groupFolder });
      }
    } catch {
      // Corrupted settings — leave as-is
      log.warn('Could not update session settings', { group: groupFolder });
    }
  }

  // Ensure IPC tool-events directory exists for this group
  const ipcToolEventsDir = path.join(DATA_DIR, 'ipc', groupFolder, 'tool-events');
  fs.mkdirSync(ipcToolEventsDir, { recursive: true });

  return groupSessionsDir;
}

/**
 * Bootstrap session settings for all known groups on startup.
 * Ensures hooks are configured even for groups with existing settings.
 */
export function bootstrapAllGroupSettings(groupFolders: string[]): void {
  for (const folder of groupFolders) {
    try {
      bootstrapSessionSettings(folder);
    } catch (err) {
      log.error('Failed to bootstrap session settings', {
        group: folder,
        err,
      });
    }
  }
}
