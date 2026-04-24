import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { insertToolCallEvent } from '../db/tool-events.js';
import { processJsonIpcDirectory } from './file-processor.js';
import { log } from '../log.js';

let watcherRunning = false;

/**
 * Process tool event JSON files from a group's IPC tool-events directory.
 */
async function processToolEvents(sourceGroup: string): Promise<void> {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const toolEventsDir = path.join(ipcBaseDir, sourceGroup, 'tool-events');
  const errorDir = path.join(ipcBaseDir, 'errors');

  await processJsonIpcDirectory({
    directory: toolEventsDir,
    errorDirectory: errorDir,
    sourceGroup,
    handle: async (data) => {
      const event = data as {
        tool_name?: string;
        tool_use_id?: string;
        session_id?: string;
        hook_event?: string;
        tool_input?: string;
        tool_response?: string;
      };
      if (!event.tool_name || !event.session_id) {
        log.warn('Skipping tool event with missing fields', {
          hasToolName: !!event.tool_name,
          hasSessionId: !!event.session_id,
        });
        return;
      }
      insertToolCallEvent({
        session_id: event.session_id,
        event_type: event.hook_event || 'PostToolUse',
        tool_name: event.tool_name,
        payload: {
          group_folder: sourceGroup,
          tool_use_id: event.tool_use_id ?? null,
          tool_input:
            typeof event.tool_input === 'string'
              ? event.tool_input
              : JSON.stringify(event.tool_input),
          tool_response:
            typeof event.tool_response === 'string'
              ? event.tool_response
              : JSON.stringify(event.tool_response),
        },
      });
      log.debug('Tool event stored', {
        tool: event.tool_name,
        session: event.session_id,
        group: sourceGroup,
      });
    },
  });
}

/**
 * Start the IPC watcher for tool events.
 * Scans all group IPC directories and processes tool-events subdirectories.
 */
export function startToolEventWatcher(): void {
  if (watcherRunning) {
    log.debug('Tool event watcher already running');
    return;
  }
  watcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processAll = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
        } catch {
          return false;
        }
      });
    } catch {
      return;
    }

    for (const sourceGroup of groupFolders) {
      try {
        await processToolEvents(sourceGroup);
      } catch (err) {
        log.error('Error processing tool events for group', {
          group: sourceGroup,
          err,
        });
      }
    }
  };

  // Use fs.watch for responsiveness, with fallback polling
  try {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const watcher = fs.watch(ipcBaseDir, { recursive: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processAll();
      }, 50);
    });
    watcher.on('error', (err) => {
      log.warn('fs.watch error on IPC directory', { err });
    });
    log.info('Tool event IPC watcher started');
  } catch (err) {
    log.warn('fs.watch failed — using polling only for tool events', { err });
  }

  // Fallback polling every 5 seconds
  setInterval(processAll, 5000);

  // Initial scan
  processAll();
}
