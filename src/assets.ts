import * as path from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function copyAddonAsset(sourcePath: string, targetPath: string, recursive: boolean): Promise<void> {
  try {
    await cp(sourcePath, targetPath, { force: true, recursive });
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Missing addon asset: ${sourcePath}`);
    }

    throw error;
  }
}

export async function installAddonAssets(context: vscode.ExtensionContext): Promise<string> {
  const storagePath = context.globalStorageUri.fsPath;
  const addonSourcePath = path.join(context.extensionUri.fsPath, 'plugin');

  await mkdir(storagePath, { recursive: true });
  await copyAddonAsset(path.join(addonSourcePath, 'plugin.lua'), path.join(storagePath, 'plugin.lua'), false);
  await copyAddonAsset(path.join(addonSourcePath, 'library'), path.join(storagePath, 'library'), true);

  return storagePath;
}
