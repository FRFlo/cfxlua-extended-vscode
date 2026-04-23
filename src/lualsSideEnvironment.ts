import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { AddonPaths } from './paths';
import {
  collectResourceScriptEntries,
  type ResourceScriptEntry,
  type ResourceScriptSide,
  resolveSingleResourcesDirectory,
} from './resourceDiscovery';

export interface LuaGlobalDeclaration {
  name: string;
  kind: 'function' | 'value';
}

interface LuaToken {
  type: 'identifier' | 'punctuation' | 'eof';
  value: string;
}

const LUA_KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
]);

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function readLongBracket(text: string, start: number): { end: number } | undefined {
  if (text[start] !== '[') {
    return undefined;
  }

  let equalsCount = 0;
  let index = start + 1;

  while (text[index] === '=') {
    equalsCount += 1;
    index += 1;
  }

  if (text[index] !== '[') {
    return undefined;
  }

  const closing = `]${'='.repeat(equalsCount)}]`;
  const closingIndex = text.indexOf(closing, index + 1);

  return {
    end: closingIndex === -1 ? text.length : closingIndex + closing.length,
  };
}

function tokenizeLuaStructure(text: string): LuaToken[] {
  const tokens: LuaToken[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (isWhitespace(character)) {
      index += 1;
      continue;
    }

    if (character === '-' && text[index + 1] === '-') {
      const blockComment = readLongBracket(text, index + 2);

      if (blockComment) {
        index = blockComment.end;
        continue;
      }

      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;

      while (index < text.length) {
        const current = text[index];

        if (current === '\\') {
          index += 2;
          continue;
        }

        index += 1;

        if (current === quote) {
          break;
        }
      }

      continue;
    }

    if (character === '[') {
      const longBracket = readLongBracket(text, index);

      if (longBracket) {
        index = longBracket.end;
        continue;
      }
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;

      while (index < text.length && isIdentifierPart(text[index])) {
        index += 1;
      }

      tokens.push({
        type: 'identifier',
        value: text.slice(start, index),
      });
      continue;
    }

    tokens.push({
      type: 'punctuation',
      value: character,
    });
    index += 1;
  }

  tokens.push({
    type: 'eof',
    value: '',
  });

  return tokens;
}

function shouldIncreaseBlockDepth(tokens: LuaToken[], index: number): boolean {
  const token = tokens[index];

  if (token.type !== 'identifier') {
    return false;
  }

  if (token.value === 'function') {
    const previous = tokens[index - 1];
    return !(previous?.type === 'identifier' && previous.value === 'local');
      
  }

  return token.value === 'do' || token.value === 'then' || token.value === 'repeat';
}

function shouldDecreaseBlockDepth(token: LuaToken): boolean {
  return token.type === 'identifier' && (token.value === 'end' || token.value === 'until');
}

function parseTopLevelAssignment(tokens: LuaToken[], startIndex: number): { declarations: LuaGlobalDeclaration[]; nextIndex: number } | undefined {
  const previous = tokens[startIndex - 1];

  if (
    (previous?.type === 'identifier' && (previous.value === 'local' || previous.value === 'for'))
    || (previous?.type === 'punctuation' && (previous.value === '.' || previous.value === ':' || previous.value === '['))
  ) {
    return undefined;
  }

  const declarations: LuaGlobalDeclaration[] = [];
  let index = startIndex;

  while (tokens[index]?.type === 'identifier' && !LUA_KEYWORDS.has(tokens[index].value)) {
    const name = tokens[index].value;
    const next = tokens[index + 1];

    if (next?.type === 'punctuation' && (next.value === '.' || next.value === ':' || next.value === '[')) {
      return undefined;
    }

    declarations.push({ name, kind: 'value' });
    index += 1;

    if (tokens[index]?.type === 'punctuation' && tokens[index].value === ',') {
      index += 1;
      continue;
    }

    break;
  }

  if (declarations.length === 0 || tokens[index]?.type !== 'punctuation' || tokens[index].value !== '=') {
    return undefined;
  }

  return {
    declarations,
    nextIndex: index,
  };
}

export function extractTopLevelGlobalDeclarations(text: string): LuaGlobalDeclaration[] {
  const tokens = tokenizeLuaStructure(text);
  const declarations = new Map<string, LuaGlobalDeclaration>();
  let blockDepth = 0;
  let nestingDepth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (shouldDecreaseBlockDepth(token)) {
      blockDepth = Math.max(0, blockDepth - 1);
    }

    if (token.type === 'punctuation') {
      if (token.value === '(' || token.value === '{' || token.value === '[') {
        nestingDepth += 1;
      } else if ((token.value === ')' || token.value === '}' || token.value === ']') && nestingDepth > 0) {
        nestingDepth -= 1;
      }

      continue;
    }

    if (token.type !== 'identifier') {
      continue;
    }

    if (blockDepth === 0 && nestingDepth === 0) {
      if (
        token.value === 'function'
        && tokens[index + 1]?.type === 'identifier'
        && !LUA_KEYWORDS.has(tokens[index + 1].value)
        && tokens[index + 2]?.type === 'punctuation'
        && tokens[index + 2].value === '('
        && !(tokens[index - 1]?.type === 'identifier' && tokens[index - 1].value === 'local')
      ) {
        declarations.set(tokens[index + 1].value, {
          name: tokens[index + 1].value,
          kind: 'function',
        });
      } else if (!LUA_KEYWORDS.has(token.value)) {
        const assignment = parseTopLevelAssignment(tokens, index);

        if (assignment) {
          for (const declaration of assignment.declarations) {
            const existing = declarations.get(declaration.name);

            if (existing?.kind === 'function') {
              continue;
            }

            declarations.set(declaration.name, declaration);
          }

          index = Math.max(index, assignment.nextIndex - 1);
        }
      }
    }

    if (shouldIncreaseBlockDepth(tokens, index)) {
      blockDepth += 1;
    }
  }

  return [...declarations.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function escapeLuaString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function serializeLuaString(value: string): string {
  return `"${escapeLuaString(value)}"`;
}

function getFileKey(uri: vscode.Uri): string {
  return uri.toString();
}

function getPreludeForDeclarations(declarations: LuaGlobalDeclaration[]): string {
  if (declarations.length === 0) {
    return '';
  }

  const lines = [
    '-- Generated by CfxLua Extended to model FiveM same-side globals.',
  ];

  for (const declaration of declarations) {
    if (declaration.kind === 'function') {
      lines.push(`function ${declaration.name}(...) end`);
    } else {
      lines.push(`${declaration.name} = nil`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function groupResourceEntries(entries: ResourceScriptEntry[]): Map<string, ResourceScriptEntry[]> {
  const groupedEntries = new Map<string, ResourceScriptEntry[]>();

  for (const entry of entries) {
    const groupKey = entry.resourceRoot.toString();
    const group = groupedEntries.get(groupKey) ?? [];
    group.push(entry);
    groupedEntries.set(groupKey, group);
  }

  return groupedEntries;
}

export function getExecutionGroupEntries(entries: ResourceScriptEntry[], scriptSide: ResourceScriptSide): ResourceScriptEntry[] {
  if (scriptSide === 'client') {
    return entries.filter((entry) => entry.scriptSide === 'client' || entry.scriptSide === 'shared');
  }

  if (scriptSide === 'server') {
    return entries.filter((entry) => entry.scriptSide === 'server' || entry.scriptSide === 'shared');
  }

  if (scriptSide === 'shared') {
    return entries.filter((entry) => entry.scriptSide === 'shared');
  }

  return [];
}

function buildAnalysisData(entries: ResourceScriptEntry[], declarationsByFile: Map<string, LuaGlobalDeclaration[]>): string {
  const groupedEntries = groupResourceEntries(entries);
  const preludeByFile = new Map<string, string>();

  for (const resourceEntries of groupedEntries.values()) {
    for (const currentEntry of resourceEntries) {
      const relatedEntries = getExecutionGroupEntries(resourceEntries, currentEntry.scriptSide)
        .filter((candidate) => candidate.fileUri.toString() !== currentEntry.fileUri.toString());
      const mergedDeclarations = new Map<string, LuaGlobalDeclaration>();

      for (const relatedEntry of relatedEntries) {
        for (const declaration of declarationsByFile.get(getFileKey(relatedEntry.fileUri)) ?? []) {
          const existing = mergedDeclarations.get(declaration.name);

          if (existing?.kind === 'function') {
            continue;
          }

          mergedDeclarations.set(declaration.name, declaration);
        }
      }

      const prelude = getPreludeForDeclarations([...mergedDeclarations.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })));

      if (prelude.length > 0) {
        preludeByFile.set(getFileKey(currentEntry.fileUri), prelude);
      }
    }
  }

  const lines = ['return {', '  files = {'];

  for (const [fileKey, prelude] of [...preludeByFile.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))) {
    lines.push(`    [${serializeLuaString(fileKey)}] = ${serializeLuaString(prelude)},`);
  }

  lines.push('  },', '}');
  return `${lines.join('\n')}\n`;
}

export async function refreshLuaSideEnvironment(addonPaths: AddonPaths): Promise<void> {
  const resourceEntries: ResourceScriptEntry[] = [];

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const resolution = await resolveSingleResourcesDirectory(workspaceFolder);

    if (!resolution.uri) {
      continue;
    }

    resourceEntries.push(...await collectResourceScriptEntries(resolution.uri));
  }

  const declarationsByFile = new Map<string, LuaGlobalDeclaration[]>();

  for (const entry of resourceEntries) {
    const content = Buffer.from(await vscode.workspace.fs.readFile(entry.fileUri)).toString('utf8');
    declarationsByFile.set(getFileKey(entry.fileUri), extractTopLevelGlobalDeclarations(content));
  }

  await writeFile(addonPaths.analysisDataFilePath, buildAnalysisData(resourceEntries, declarationsByFile), 'utf8');
}

export function registerLuaSideEnvironmentSync(addonPaths: AddonPaths): vscode.Disposable {
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshChain = Promise.resolve();

  const runRefresh = () => {
    refreshChain = refreshChain
      .catch(() => undefined)
      .then(async () => {
        await refreshLuaSideEnvironment(addonPaths);
      });
  };

  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      runRefresh();
    }, 150);
  };

  const disposables: vscode.Disposable[] = [
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'lua') {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduleRefresh();
    }),
  ];

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '**/*.lua'));
    watcher.onDidCreate(scheduleRefresh, undefined, disposables);
    watcher.onDidChange(scheduleRefresh, undefined, disposables);
    watcher.onDidDelete(scheduleRefresh, undefined, disposables);
    disposables.push(watcher);
  }

  scheduleRefresh();

  const disposable = new vscode.Disposable(() => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    for (const entry of disposables) {
      entry.dispose();
    }
  });

  return disposable;
}
