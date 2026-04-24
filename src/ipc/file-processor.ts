import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

export interface JsonIpcFileProcessorOptions {
  directory: string;
  errorDirectory: string;
  sourceGroup: string;
  handle: (data: unknown) => Promise<void>;
}

export async function processJsonIpcDirectory(
  options: JsonIpcFileProcessorOptions,
): Promise<void> {
  if (!fs.existsSync(options.directory)) {
    return;
  }

  const files = fs
    .readdirSync(options.directory)
    .filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(options.directory, file);

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      await options.handle(data);
      fs.unlinkSync(filePath);
    } catch (err) {
      log.warn('Error processing IPC file', { file, err });
      fs.mkdirSync(options.errorDirectory, { recursive: true });

      try {
        if (fs.existsSync(filePath)) {
          fs.renameSync(
            filePath,
            path.join(options.errorDirectory, `${options.sourceGroup}-${file}`),
          );
        }
      } catch (moveErr) {
        log.error('Failed to quarantine IPC file', { file, err: moveErr });
      }
    }
  }
}
