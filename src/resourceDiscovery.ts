import * as vscode from 'vscode';
import {
  MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
  RESOURCE_DIRECTORY_NAME,
  RESOURCE_SCAN_EXCLUDED_DIRECTORIES,
} from './constants';

export interface ResolvedResourcesDirectory {
  uri?: vscode.Uri;
  message?: string;
}

function isExcludedDirectory(name: string): boolean {
  return RESOURCE_SCAN_EXCLUDED_DIRECTORIES.includes(name as (typeof RESOURCE_SCAN_EXCLUDED_DIRECTORIES)[number]);
}

export function isResourcesDirectoryName(name: string): boolean {
  return name === RESOURCE_DIRECTORY_NAME;
}

export async function readDirectoryEntries(uri: vscode.Uri): Promise<readonly [string, vscode.FileType][]> {
  return vscode.workspace.fs.readDirectory(uri);
}

export async function readChildDirectories(uri: vscode.Uri): Promise<Array<{ name: string; uri: vscode.Uri }>> {
  const entries = await readDirectoryEntries(uri);

  return entries
    .filter(
      ([entryName, entryType]) =>
        entryType === vscode.FileType.Directory && !isExcludedDirectory(entryName),
    )
    .map(([entryName]) => ({
      name: entryName,
      uri: vscode.Uri.joinPath(uri, entryName),
    }));
}

export async function resolveResourcesDirectories(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const directories = await readChildDirectories(folder.uri);
  const candidates = directories
    .filter((directory) => isResourcesDirectoryName(directory.name))
    .map((directory) => directory.uri);

  const nestedCandidates = await Promise.all(
    directories
      .filter((directory) => !isResourcesDirectoryName(directory.name))
      .map(async (directory) => {
        const childDirectories = await readChildDirectories(directory.uri);
        const resourcesDirectory = childDirectories.find((child) => isResourcesDirectoryName(child.name));

        return resourcesDirectory?.uri;
      }),
  );

  return [...candidates, ...nestedCandidates.filter((uri): uri is vscode.Uri => uri !== undefined)];
}

export async function resolveSingleResourcesDirectory(folder: vscode.WorkspaceFolder): Promise<ResolvedResourcesDirectory> {
  const resourcesDirectories = await resolveResourcesDirectories(folder);

  if (resourcesDirectories.length === 0) {
    return {};
  }

  if (resourcesDirectories.length > 1) {
    return {
      message: MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
    };
  }

  return {
    uri: resourcesDirectories[0],
  };
}

export async function collectLuaFilesInDirectory(root: vscode.Uri): Promise<vscode.Uri[]> {
  const collected: vscode.Uri[] = [];
  const pending: vscode.Uri[] = [root];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readDirectoryEntries(current);

    for (const [entryName, entryType] of entries) {
      const entryUri = vscode.Uri.joinPath(current, entryName);

      if (entryType === vscode.FileType.Directory) {
        if (!isExcludedDirectory(entryName)) {
          pending.push(entryUri);
        }

        continue;
      }

      if (entryType === vscode.FileType.File && entryName.toLowerCase().endsWith('.lua')) {
        collected.push(entryUri);
      }
    }
  }

  return collected.sort((left, right) => left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: 'base' }));
}
