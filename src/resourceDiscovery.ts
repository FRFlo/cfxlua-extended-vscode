import * as vscode from 'vscode';
import {
  LEGACY_RESOURCE_MANIFEST_FILENAME,
  MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
  RESOURCE_DIRECTORY_NAME,
  RESOURCE_MANIFEST_FILENAME,
  RESOURCE_SCAN_EXCLUDED_DIRECTORIES,
} from './constants';

export interface ResolvedResourcesDirectory {
  uri?: vscode.Uri;
  message?: string;
}

export type ResourceScriptSide = 'client' | 'server' | 'shared' | 'unknown';

export interface ResourceScriptEntry {
  fileUri: vscode.Uri;
  resourceRoot: vscode.Uri;
  manifestUri: vscode.Uri;
  scriptSide: ResourceScriptSide;
}

interface ParsedManifestScripts {
  client: string[];
  server: string[];
  shared: string[];
}

const RESOURCE_MANIFEST_FILENAMES = [RESOURCE_MANIFEST_FILENAME, LEGACY_RESOURCE_MANIFEST_FILENAME] as const;
const MANIFEST_SCRIPT_DIRECTIVES = {
  client: ['client_script', 'client_scripts'],
  server: ['server_script', 'server_scripts'],
  shared: ['shared_script', 'shared_scripts'],
} as const;

function isExcludedDirectory(name: string): boolean {
  return RESOURCE_SCAN_EXCLUDED_DIRECTORIES.includes(name as (typeof RESOURCE_SCAN_EXCLUDED_DIRECTORIES)[number]);
}

export function isResourcesDirectoryName(name: string): boolean {
  return name === RESOURCE_DIRECTORY_NAME;
}

export async function readDirectoryEntries(uri: vscode.Uri): Promise<readonly [string, vscode.FileType][]> {
  return vscode.workspace.fs.readDirectory(uri);
}

function normalizeResourcePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];

    if (character === '*') {
      const nextCharacter = glob[index + 1];

      if (nextCharacter === '*') {
        pattern += '.*';
        index += 1;
        continue;
      }

      pattern += '[^/]*';
      continue;
    }

    if (character === '?') {
      pattern += '.';
      continue;
    }

    pattern += /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
  }

  pattern += '$';
  return new RegExp(pattern, 'i');
}

function extractQuotedStrings(text: string): string[] {
  const matches = text.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g);
  return [...matches].map((match) => match[2]).filter((value) => value.length > 0);
}

function readBalancedBlock(text: string, startIndex: number, openCharacter: string, closeCharacter: string): { value: string; nextIndex: number } {
  let depth = 0;
  let inString: '"' | "'" | undefined;
  let isEscaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === '\\') {
        isEscaped = true;
        continue;
      }

      if (character === inString) {
        inString = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = character;
      continue;
    }

    if (character === openCharacter) {
      depth += 1;
      continue;
    }

    if (character === closeCharacter) {
      depth -= 1;

      if (depth === 0) {
        return {
          value: text.slice(startIndex, index + 1),
          nextIndex: index + 1,
        };
      }
    }
  }

  return {
    value: text.slice(startIndex),
    nextIndex: text.length,
  };
}

function parseDirectiveValues(text: string, startIndex: number): { values: string[]; nextIndex: number } {
  let index = startIndex;

  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  const character = text[index];

  if (character === '"' || character === "'") {
    const values = extractQuotedStrings(text.slice(index, text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index)));
    return {
      values,
      nextIndex: text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index),
    };
  }

  if (character === '{') {
    const block = readBalancedBlock(text, index, '{', '}');
    return {
      values: extractQuotedStrings(block.value),
      nextIndex: block.nextIndex,
    };
  }

  if (character === '(') {
    const block = readBalancedBlock(text, index, '(', ')');
    return {
      values: extractQuotedStrings(block.value),
      nextIndex: block.nextIndex,
    };
  }

  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
  return {
    values: extractQuotedStrings(line),
    nextIndex: lineEnd === -1 ? text.length : lineEnd,
  };
}

function parseManifestScripts(text: string): ParsedManifestScripts {
  const scripts: ParsedManifestScripts = {
    client: [],
    server: [],
    shared: [],
  };

  const directivePattern = /\b(client_script|client_scripts|server_script|server_scripts|shared_script|shared_scripts)\b/g;
  let match = directivePattern.exec(text);

  while (match) {
    const directive = match[1];
    const result = parseDirectiveValues(text, match.index + directive.length);

    if (MANIFEST_SCRIPT_DIRECTIVES.client.includes(directive as (typeof MANIFEST_SCRIPT_DIRECTIVES.client)[number])) {
      scripts.client.push(...result.values);
    }

    if (MANIFEST_SCRIPT_DIRECTIVES.server.includes(directive as (typeof MANIFEST_SCRIPT_DIRECTIVES.server)[number])) {
      scripts.server.push(...result.values);
    }

    if (MANIFEST_SCRIPT_DIRECTIVES.shared.includes(directive as (typeof MANIFEST_SCRIPT_DIRECTIVES.shared)[number])) {
      scripts.shared.push(...result.values);
    }

    directivePattern.lastIndex = result.nextIndex;
    match = directivePattern.exec(text);
  }

  return scripts;
}

function determineScriptSide(relativePath: string, parsedManifest: ParsedManifestScripts): ResourceScriptSide {
  const normalizedRelativePath = normalizeResourcePath(relativePath);
  const clientMatch = parsedManifest.client.some((pattern) => matchesManifestScript(normalizedRelativePath, pattern));
  const serverMatch = parsedManifest.server.some((pattern) => matchesManifestScript(normalizedRelativePath, pattern));
  const sharedMatch = parsedManifest.shared.some((pattern) => matchesManifestScript(normalizedRelativePath, pattern));

  if (sharedMatch || (clientMatch && serverMatch)) {
    return 'shared';
  }

  if (clientMatch) {
    return 'client';
  }

  if (serverMatch) {
    return 'server';
  }

  return 'unknown';
}

function matchesManifestScript(relativePath: string, manifestPattern: string): boolean {
  if (manifestPattern.startsWith('@')) {
    return false;
  }

  const normalizedPattern = normalizeResourcePath(manifestPattern);
  return globToRegExp(normalizedPattern).test(relativePath);
}

export function inferScriptSide(relativePath: string, manifestText: string): ResourceScriptSide {
  return determineScriptSide(relativePath, parseManifestScripts(manifestText));
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

export async function findResourceManifestUri(resourceRoot: vscode.Uri): Promise<vscode.Uri | undefined> {
  const entries = await readDirectoryEntries(resourceRoot);
  const manifest = entries.find(
    ([entryName, entryType]) =>
      entryType === vscode.FileType.File
      && RESOURCE_MANIFEST_FILENAMES.includes(entryName.toLowerCase() as (typeof RESOURCE_MANIFEST_FILENAMES)[number]),
  );

  if (!manifest) {
    return undefined;
  }

  return vscode.Uri.joinPath(resourceRoot, manifest[0]);
}

export async function hasResourceManifest(resourceRoot: vscode.Uri): Promise<boolean> {
  return (await findResourceManifestUri(resourceRoot)) !== undefined;
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

async function collectResourceRoots(root: vscode.Uri): Promise<vscode.Uri[]> {
  const resourceRoots: vscode.Uri[] = [];
  const pending: vscode.Uri[] = [root];

  while (pending.length > 0) {
    const current = pending.pop()!;

    if (await hasResourceManifest(current)) {
      resourceRoots.push(current);
      continue;
    }

    const childDirectories = await readChildDirectories(current);
    pending.push(...childDirectories.map((directory) => directory.uri));
  }

  return resourceRoots.sort((left, right) => left.fsPath.localeCompare(right.fsPath, undefined, { sensitivity: 'base' }));
}

export async function collectResourceScriptEntries(resourcesRoot: vscode.Uri): Promise<ResourceScriptEntry[]> {
  const resourceRoots = await collectResourceRoots(resourcesRoot);
  const entries: ResourceScriptEntry[] = [];

  for (const resourceRoot of resourceRoots) {
    const manifestUri = await findResourceManifestUri(resourceRoot);

    if (!manifestUri) {
      continue;
    }

    const manifestContent = Buffer.from(await vscode.workspace.fs.readFile(manifestUri)).toString('utf8');
    const luaFiles = await collectLuaFilesInDirectory(resourceRoot);
    const parsedManifest = parseManifestScripts(manifestContent);

    for (const fileUri of luaFiles) {
      const relativePath = normalizeResourcePath(vscode.workspace.asRelativePath(fileUri, false).replace(normalizeResourcePath(resourceRoot.path).replace(/^\//, ''), '').replace(/^\//, ''));

      if (RESOURCE_MANIFEST_FILENAMES.includes(fileUri.path.split('/').pop()?.toLowerCase() as (typeof RESOURCE_MANIFEST_FILENAMES)[number])) {
        continue;
      }

      const resourceRelativePath = normalizeResourcePath(vscode.workspace.asRelativePath(vscode.Uri.joinPath(resourceRoot, relativePath), false));
      const normalizedRootPath = normalizeResourcePath(resourceRoot.path);
      const normalizedFilePath = normalizeResourcePath(fileUri.path);
      const fileRelativePath = normalizedFilePath.startsWith(`${normalizedRootPath}/`)
        ? normalizedFilePath.slice(normalizedRootPath.length + 1)
        : relativePath || resourceRelativePath;

      entries.push({
        fileUri,
        resourceRoot,
        manifestUri,
        scriptSide: determineScriptSide(fileRelativePath, parsedManifest),
      });
    }
  }

  return entries.sort((left, right) => left.fileUri.fsPath.localeCompare(right.fileUri.fsPath, undefined, { sensitivity: 'base' }));
}
