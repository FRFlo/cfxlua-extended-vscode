import * as vscode from 'vscode';
import { COMMAND_SHOW_EVENT_USAGES } from './constants';
import { collectLuaFilesInDirectory, resolveSingleResourcesDirectory } from './resourceDiscovery';

const EVENT_LISTENER_APIS = ['AddEventHandler', 'RegisterNetEvent', 'RegisterServerEvent'] as const;
const EVENT_TRIGGER_APIS = [
  'TriggerEvent',
  'TriggerServerEvent',
  'TriggerClientEvent',
  'TriggerLatentServerEvent',
  'TriggerLatentClientEvent',
] as const;
const EVENT_APIS = [...EVENT_LISTENER_APIS, ...EVENT_TRIGGER_APIS] as const;
const CODELENS_APIS = new Set<string>(EVENT_LISTENER_APIS);

type EventOccurrenceKind = 'listener' | 'trigger';
type EventApiName = (typeof EVENT_APIS)[number];

export interface EventOccurrence {
  name: string;
  api: EventApiName;
  kind: EventOccurrenceKind;
  uri: vscode.Uri;
  range: vscode.Range;
}

interface EventIndexData {
  occurrences: EventOccurrence[];
  occurrencesByName: Map<string, EventOccurrence[]>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getOccurrenceKind(api: EventApiName): EventOccurrenceKind {
  return CODELENS_APIS.has(api) ? 'listener' : 'trigger';
}

function decodeLuaStringLiteral(value: string): string {
  return value.replace(/\\([\\'"nrt])/g, (_match, group: string) => {
    switch (group) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return group;
    }
  });
}

function buildEventPattern(api: EventApiName, quote: '"' | "'"): RegExp {
  const contentPattern = quote === '"' ? '"((?:\\\\.|[^"\\\\])*)"' : "'((?:\\\\.|[^'\\\\])*)'";
  return new RegExp(`\\b${escapeRegex(api)}\\s*\\(\\s*${contentPattern}`, 'g');
}

function compareOccurrences(left: EventOccurrence, right: EventOccurrence): number {
  const uriCompare = left.uri.toString().localeCompare(right.uri.toString(), undefined, { sensitivity: 'base' });

  if (uriCompare !== 0) {
    return uriCompare;
  }

  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }

  return left.range.start.character - right.range.start.character;
}

function isSameOccurrence(left: EventOccurrence, right: EventOccurrence): boolean {
  return left.uri.toString() === right.uri.toString()
    && left.range.start.isEqual(right.range.start)
    && left.range.end.isEqual(right.range.end)
    && left.api === right.api;
}

export function extractEventOccurrences(text: string, uri: vscode.Uri): EventOccurrence[] {
  const occurrences: EventOccurrence[] = [];

  for (const api of EVENT_APIS) {
    for (const quote of ['"', "'"] as const) {
      const pattern = buildEventPattern(api, quote);

      for (const match of text.matchAll(pattern)) {
        const rawName = match[1];

        if (rawName === undefined || match.index === undefined) {
          continue;
        }

        const matchedText = match[0];
        const quoteIndex = matchedText.indexOf(quote);
        const nameStartOffset = match.index + quoteIndex + 1;
        const nameEndOffset = nameStartOffset + rawName.length;

        occurrences.push({
          name: decodeLuaStringLiteral(rawName),
          api,
          kind: getOccurrenceKind(api),
          uri,
          range: new vscode.Range(
            positionAt(text, nameStartOffset),
            positionAt(text, nameEndOffset),
          ),
        });
      }
    }
  }

  return occurrences.sort(compareOccurrences);
}

function positionAt(text: string, offset: number): vscode.Position {
  let line = 0;
  let character = 0;

  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      character = 0;
      continue;
    }

    character += 1;
  }

  return new vscode.Position(line, character);
}

export function findEventOccurrenceAtPosition(document: vscode.TextDocument, position: vscode.Position): EventOccurrence | undefined {
  const occurrences = extractEventOccurrences(document.getText(), document.uri);

  return occurrences.find((occurrence) => occurrence.range.contains(position));
}

export function isEventArgumentContext(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (findEventOccurrenceAtPosition(document, position)) {
    return true;
  }

  const offset = document.offsetAt(position);
  const startOffset = Math.max(0, offset - 500);
  const prefix = document.getText(new vscode.Range(document.positionAt(startOffset), position));
  const apiPattern = EVENT_APIS.map(escapeRegex).join('|');
  const patterns = [
    new RegExp(`\\b(?:${apiPattern})\\s*\\(\\s*"(?:\\\\.|[^"\\\\])*$`),
    new RegExp(`\\b(?:${apiPattern})\\s*\\(\\s*'(?:\\\\.|[^'\\\\])*$`),
  ];

  return patterns.some((pattern) => pattern.test(prefix));
}

class WorkspaceEventIndex {
  private cachedIndex: EventIndexData | undefined;
  private scanPromise: Promise<EventIndexData> | undefined;

  invalidate(): void {
    this.cachedIndex = undefined;
    this.scanPromise = undefined;
  }

  async getOccurrencesForName(name: string): Promise<EventOccurrence[]> {
    const index = await this.getIndex();
    return index.occurrencesByName.get(name) ?? [];
  }

  async getNames(): Promise<string[]> {
    const index = await this.getIndex();
    return [...index.occurrencesByName.keys()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }

  private async getIndex(): Promise<EventIndexData> {
    if (this.cachedIndex) {
      return this.cachedIndex;
    }

    if (!this.scanPromise) {
      this.scanPromise = this.scanWorkspace();
    }

    this.cachedIndex = await this.scanPromise;
    this.scanPromise = undefined;

    return this.cachedIndex;
  }

  private async scanWorkspace(): Promise<EventIndexData> {
    const occurrences: EventOccurrence[] = [];
    const scannedUris = new Set<string>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const resolution = await resolveSingleResourcesDirectory(folder);

      if (!resolution.uri) {
        continue;
      }

      const luaFiles = await collectLuaFilesInDirectory(resolution.uri);

      for (const uri of luaFiles) {
        const key = uri.toString();

        if (scannedUris.has(key)) {
          continue;
        }

        scannedUris.add(key);
        const text = await readWorkspaceLuaText(uri);
        occurrences.push(...extractEventOccurrences(text, uri));
      }
    }

    const occurrencesByName = new Map<string, EventOccurrence[]>();

    for (const occurrence of occurrences) {
      const current = occurrencesByName.get(occurrence.name) ?? [];
      current.push(occurrence);
      occurrencesByName.set(occurrence.name, current);
    }

    for (const matches of occurrencesByName.values()) {
      matches.sort(compareOccurrences);
    }

    return {
      occurrences: occurrences.sort(compareOccurrences),
      occurrencesByName,
    };
  }
}

async function readWorkspaceLuaText(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

  if (openDocument) {
    return openDocument.getText();
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function createReferenceLocations(occurrences: EventOccurrence[]): vscode.Location[] {
  return occurrences.map((occurrence) => new vscode.Location(occurrence.uri, occurrence.range));
}

function pluralizeUsage(count: number): string {
  return `${count} usage${count === 1 ? '' : 's'}`;
}

export function registerEventIntelligence(context: vscode.ExtensionContext): vscode.Disposable[] {
  const eventIndex = new WorkspaceEventIndex();
  const selector: vscode.DocumentSelector = [{ language: 'lua' }];
  const watcherDisposables: vscode.Disposable[] = [];

  const invalidateIndex = () => {
    eventIndex.invalidate();
  };

  const resourcePatterns = [
    'resources/**/*.lua',
    '*/resources/**/*.lua',
    'resources',
    'resources/**',
    '*/resources',
    '*/resources/**',
  ];

  const resetWatchers = () => {
    while (watcherDisposables.length > 0) {
      watcherDisposables.pop()?.dispose();
    }

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of resourcePatterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, pattern));
        watcher.onDidCreate(invalidateIndex, undefined, watcherDisposables);
        watcher.onDidChange(invalidateIndex, undefined, watcherDisposables);
        watcher.onDidDelete(invalidateIndex, undefined, watcherDisposables);
        watcherDisposables.push(watcher);
      }
    }
  };

  resetWatchers();

  const workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    resetWatchers();
    invalidateIndex();
  });
  const textChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'lua') {
      invalidateIndex();
    }
  });
  const openSubscription = vscode.workspace.onDidOpenTextDocument((document) => {
    if (document.languageId === 'lua') {
      invalidateIndex();
    }
  });
  const closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.languageId === 'lua') {
      invalidateIndex();
    }
  });

  const completionProvider = vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position) {
      if (!isEventArgumentContext(document, position)) {
        return undefined;
      }

      const names = await eventIndex.getNames();

      return names.map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
        item.detail = 'Indexed FiveM event';
        item.insertText = name;
        return item;
      });
    },
  }, '"', "'");

  const referenceProvider = vscode.languages.registerReferenceProvider(selector, {
    async provideReferences(document, position, context) {
      const occurrence = findEventOccurrenceAtPosition(document, position);

      if (!occurrence) {
        return undefined;
      }

      const matches = await eventIndex.getOccurrencesForName(occurrence.name);
      const filteredMatches = context.includeDeclaration
        ? matches
        : matches.filter((match) => !isSameOccurrence(match, occurrence));

      return createReferenceLocations(filteredMatches);
    },
  });

  const codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
    async provideCodeLenses(document) {
      const documentOccurrences = extractEventOccurrences(document.getText(), document.uri)
        .filter((occurrence) => occurrence.kind === 'listener');

      if (documentOccurrences.length === 0) {
        return [];
      }

      const lenses = await Promise.all(documentOccurrences.map(async (occurrence) => {
        const matches = await eventIndex.getOccurrencesForName(occurrence.name);
        const usages = matches.filter((match) => !isSameOccurrence(match, occurrence));
        const locations = createReferenceLocations(usages);

        return new vscode.CodeLens(occurrence.range, {
          title: pluralizeUsage(usages.length),
          command: COMMAND_SHOW_EVENT_USAGES,
          arguments: [occurrence.uri, occurrence.range.start, locations, occurrence.name],
        });
      }));

      return lenses;
    },
  });

  const showUsagesCommand = vscode.commands.registerCommand(
    COMMAND_SHOW_EVENT_USAGES,
    async (uri: vscode.Uri, position: vscode.Position, locations: vscode.Location[], eventName: string) => {
      if (locations.length === 0) {
        await vscode.window.showInformationMessage(`No indexed usages found for '${eventName}'.`);
        return;
      }

      await vscode.commands.executeCommand('editor.action.showReferences', uri, position, locations);
    },
  );

  return [
    workspaceFoldersSubscription,
    textChangeSubscription,
    openSubscription,
    closeSubscription,
    completionProvider,
    referenceProvider,
    codeLensProvider,
    showUsagesCommand,
    new vscode.Disposable(() => {
      while (watcherDisposables.length > 0) {
        watcherDisposables.pop()?.dispose();
      }
    }),
  ];
}
