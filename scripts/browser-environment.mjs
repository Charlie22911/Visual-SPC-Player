import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const browserLaunchOptions = {
  headless: true,
  ...(process.env.SPC_BROWSER_CHANNEL ? { channel: process.env.SPC_BROWSER_CHANNEL } : {}),
};

export const browserName = process.env.SPC_BROWSER_CHANNEL || 'Chromium';

export const artifactPath = (name) => {
  const directory = process.env.SPC_ARTIFACT_DIR
    ? resolve(process.env.SPC_ARTIFACT_DIR)
    : fileURLToPath(new URL('../artifacts/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
};
