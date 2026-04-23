import * as vscode from 'vscode';
import { COMMAND_SHOW_EVENT_USAGES } from './constants';
import { createLineStarts, findLuaCalls } from './luaCallParsing';
import {
  collectResourceScriptEntries,
  ResourceScriptEntry,
  ResourceScriptSide,
  resolveSingleResourcesDirectory,
} from './resourceDiscovery';

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
const EVENT_API_SET = new Set<string>(EVENT_APIS);

type EventOccurrenceKind = 'listener' | 'trigger';
type EventApiName = (typeof EVENT_APIS)[number];
type ExecutionSide = 'client' | 'server';
type LuaQuote = '"' | "'";

function isSupportedEventStringQuote(quote: '"' | "'" | '['): quote is LuaQuote {
  return quote === '"' || quote === "'";
}

export interface EventOccurrence {
  name: string;
  api: EventApiName;
  kind: EventOccurrenceKind;
  uri: vscode.Uri;
  range: vscode.Range;
  resourceRoot?: vscode.Uri;
  manifestUri?: vscode.Uri;
  scriptSide: ResourceScriptSide;
}

interface EventIndexData {
  occurrences: EventOccurrence[];
  occurrencesByName: Map<string, EventOccurrence[]>;
}

export interface EventUsageGroup {
  title: string;
  locations: vscode.Location[];
}

export interface ResourceEventEntry {
  name: string;
  locations: vscode.Location[];
}

export interface ResourceEventGroup {
  title: string;
  kind: EventOccurrenceKind;
  locations: vscode.Location[];
  events: ResourceEventEntry[];
}

function getOccurrenceKind(api: EventApiName): EventOccurrenceKind {
  return CODELENS_APIS.has(api) ? 'listener' : 'trigger';
}

export function escapeLuaStringLiteral(value: string, quote: LuaQuote): string {
  const escapedValue = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');

  if (quote === '"') {
    return escapedValue.replace(/"/g, '\\"');
  }

  return escapedValue.replace(/'/g, "\\'");
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

function getExecutionSides(scriptSide: ResourceScriptSide): ExecutionSide[] {
  if (scriptSide === 'client') {
    return ['client'];
  }

  if (scriptSide === 'server') {
    return ['server'];
  }

  return ['client', 'server'];
}

function getReachableSides(occurrence: EventOccurrence): ExecutionSide[] {
  switch (occurrence.api) {
    case 'TriggerServerEvent':
    case 'TriggerLatentServerEvent':
      return ['server'];
    case 'TriggerClientEvent':
    case 'TriggerLatentClientEvent':
      return ['client'];
    case 'TriggerEvent':
      return getExecutionSides(occurrence.scriptSide);
    default:
      return getExecutionSides(occurrence.scriptSide);
  }
}

function intersectsExecutionSides(left: ExecutionSide[], right: ExecutionSide[]): boolean {
  return left.some((side) => right.includes(side));
}

function areRelatedOccurrences(source: EventOccurrence, candidate: EventOccurrence): boolean {
  if (source.name !== candidate.name) {
    return false;
  }

  return intersectsExecutionSides(getReachableSides(source), getReachableSides(candidate));
}

function getSideAwareMatches(source: EventOccurrence, matches: EventOccurrence[]): EventOccurrence[] {
  return matches.filter((candidate) => areRelatedOccurrences(source, candidate));
}

export function getRelatedEventOccurrences(source: EventOccurrence, matches: EventOccurrence[]): EventOccurrence[] {
  return getSideAwareMatches(source, matches);
}

function getCurrentExecutionSides(api: EventApiName | undefined, scriptSide: ResourceScriptSide): ExecutionSide[] {
  if (!api) {
    return getExecutionSides(scriptSide);
  }

  switch (api) {
    case 'TriggerServerEvent':
    case 'TriggerLatentServerEvent':
      return ['server'];
    case 'TriggerClientEvent':
    case 'TriggerLatentClientEvent':
      return ['client'];
    default:
      return getExecutionSides(scriptSide);
  }
}

function isOffsetInsideStringArgument(start: number, end: number, offset: number): boolean {
  return offset >= start && offset <= end;
}

function getEventApiAtOffset(text: string, offset: number): EventApiName | undefined {
  for (const call of findLuaCalls(text, EVENT_API_SET)) {
    const firstArgument = call.arguments[0];

    if (firstArgument?.kind !== 'string' || !isSupportedEventStringQuote(firstArgument.literal.quote)) {
      continue;
    }

    if (isOffsetInsideStringArgument(firstArgument.literal.contentStart, firstArgument.literal.contentEnd, offset)) {
      return call.name as EventApiName;
    }
  }

  return undefined;
}

function getApiAtPosition(document: vscode.TextDocument, position: vscode.Position): EventApiName | undefined {
  const occurrence = findEventOccurrenceAtPosition(document, position);

  if (occurrence) {
    return occurrence.api;
  }

  return getEventApiAtOffset(document.getText(), document.offsetAt(position));
}

export function extractEventOccurrences(text: string, uri: vscode.Uri, context?: Partial<Pick<EventOccurrence, 'resourceRoot' | 'manifestUri' | 'scriptSide'>>): EventOccurrence[] {
  const occurrences: EventOccurrence[] = [];

  const lineStarts = createLineStarts(text);

  for (const call of findLuaCalls(text, EVENT_API_SET)) {
    const firstArgument = call.arguments[0];

    if (firstArgument?.kind !== 'string' || !isSupportedEventStringQuote(firstArgument.literal.quote)) {
      continue;
    }

    const api = call.name as EventApiName;
    occurrences.push({
      name: firstArgument.literal.value,
      api,
      kind: getOccurrenceKind(api),
      uri,
      resourceRoot: context?.resourceRoot,
      manifestUri: context?.manifestUri,
      scriptSide: context?.scriptSide ?? 'unknown',
      range: new vscode.Range(
        positionAt(lineStarts, firstArgument.literal.contentStart),
        positionAt(lineStarts, firstArgument.literal.contentEnd),
      ),
    });
  }

  return occurrences.sort(compareOccurrences);
}

function positionAt(lineStarts: number[], offset: number): vscode.Position {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle];
    const nextStart = lineStarts[middle + 1] ?? Number.MAX_SAFE_INTEGER;

    if (offset < start) {
      high = middle - 1;
      continue;
    }

    if (offset >= nextStart) {
      low = middle + 1;
      continue;
    }

    return new vscode.Position(middle, offset - start);
  }

  const lastLine = lineStarts.length - 1;
  return new vscode.Position(lastLine, offset - lineStarts[lastLine]);
}

export function findEventOccurrenceAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  context?: Partial<Pick<EventOccurrence, 'resourceRoot' | 'manifestUri' | 'scriptSide'>>,
): EventOccurrence | undefined {
  const occurrences = extractEventOccurrences(document.getText(), document.uri, context);

  return occurrences.find((occurrence) => occurrence.range.contains(position));
}

function getLuaQuoteForOccurrence(document: vscode.TextDocument, occurrence: EventOccurrence): LuaQuote | undefined {
  if (occurrence.range.start.character === 0) {
    return undefined;
  }

  const quotePosition = occurrence.range.start.translate(0, -1);
  const quoteCharacter = document.getText(new vscode.Range(quotePosition, occurrence.range.start));

  if (quoteCharacter === '"' || quoteCharacter === "'") {
    return quoteCharacter;
  }

  return undefined;
}

async function resolveEventTargetsAtPosition(
  eventIndex: WorkspaceEventIndex,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<{ occurrence: EventOccurrence; relatedMatches: EventOccurrence[] } | undefined> {
  const scriptSide = await eventIndex.getScriptSideForUri(document.uri);
  const occurrence = findEventOccurrenceAtPosition(document, position, { scriptSide });

  if (!occurrence) {
    return undefined;
  }

  const matches = await eventIndex.getOccurrencesForName(occurrence.name);

  return {
    occurrence,
    relatedMatches: getRelatedEventOccurrences(occurrence, matches),
  };
}

export function isEventArgumentContext(document: vscode.TextDocument, position: vscode.Position): boolean {
  if (findEventOccurrenceAtPosition(document, position)) {
    return true;
  }

  return getEventApiAtOffset(document.getText(), document.offsetAt(position)) !== undefined;
}

function getRoleLabelForKind(kind: EventOccurrenceKind): string {
  return kind === 'trigger' ? 'Emitter' : 'Receiver';
}

export class WorkspaceEventIndex {
  private readonly onDidInvalidateEmitter = new vscode.EventEmitter<void>();
  private cachedIndex: EventIndexData | undefined;
  private scanPromise: Promise<EventIndexData> | undefined;
  private cachedScriptsByUri: Map<string, ResourceScriptEntry> | undefined;

  readonly onDidInvalidate = this.onDidInvalidateEmitter.event;

  invalidate(): void {
    this.cachedIndex = undefined;
    this.scanPromise = undefined;
    this.cachedScriptsByUri = undefined;
    this.onDidInvalidateEmitter.fire();
  }

  async getOccurrencesForName(name: string): Promise<EventOccurrence[]> {
    const index = await this.getIndex();
    return index.occurrencesByName.get(name) ?? [];
  }

  async getNames(): Promise<string[]> {
    const index = await this.getIndex();
    return [...index.occurrencesByName.keys()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }

  async getScriptSideForUri(uri: vscode.Uri): Promise<ResourceScriptSide> {
    const index = await this.getIndex();
    return this.cachedScriptsByUri?.get(uri.toString())?.scriptSide ?? (index.occurrences.find((occurrence) => occurrence.uri.toString() === uri.toString())?.scriptSide ?? 'unknown');
  }

  async getResourceEventGroups(resourceRoot: vscode.Uri): Promise<ResourceEventGroup[]> {
    const index = await this.getIndex();
    const resourceKey = resourceRoot.toString();
    const occurrences = index.occurrences.filter((occurrence) => occurrence.resourceRoot?.toString() === resourceKey);
    return getResourceEventGroupsFromOccurrences(occurrences);
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
    const scriptsByUri = new Map<string, ResourceScriptEntry>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const resolution = await resolveSingleResourcesDirectory(folder);

      if (!resolution.uri) {
        continue;
      }

      const scriptEntries = await collectResourceScriptEntries(resolution.uri);

      for (const scriptEntry of scriptEntries) {
        const key = scriptEntry.fileUri.toString();

        if (scannedUris.has(key)) {
          continue;
        }

        scannedUris.add(key);
        scriptsByUri.set(key, scriptEntry);
        const text = await readWorkspaceLuaText(scriptEntry.fileUri);
        occurrences.push(...extractEventOccurrences(text, scriptEntry.fileUri, scriptEntry));
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

    this.cachedScriptsByUri = scriptsByUri;

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

function pluralizeCategory(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getCategoryLabel(kind: EventOccurrenceKind, similar: boolean): string {
  if (similar) {
    return getRoleLabelForKind(kind);
  }

  return getRoleLabelForKind(kind === 'listener' ? 'trigger' : 'listener');
}

export function getResourceEventGroupsFromOccurrences(occurrences: EventOccurrence[]): ResourceEventGroup[] {
  const groups: ResourceEventGroup[] = [];

  for (const kind of ['trigger', 'listener'] as const) {
    const matches = occurrences.filter((occurrence) => occurrence.kind === kind);

    if (matches.length === 0) {
      continue;
    }

    const byName = new Map<string, EventOccurrence[]>();

    for (const occurrence of matches) {
      const current = byName.get(occurrence.name) ?? [];
      current.push(occurrence);
      byName.set(occurrence.name, current);
    }

    const events = [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
      .map(([name, eventOccurrences]) => ({
        name,
        locations: createReferenceLocations(eventOccurrences.sort(compareOccurrences)),
      }));

    groups.push({
      title: getRoleLabelForKind(kind),
      kind,
      locations: createReferenceLocations(matches.sort(compareOccurrences)),
      events,
    });
  }

  return groups;
}

export function getUsageGroupsForOccurrence(source: EventOccurrence, matches: EventOccurrence[]): EventUsageGroup[] {
  const relatedMatches = getSideAwareMatches(source, matches).filter((match) => !isSameOccurrence(match, source));
  const similarMatches = relatedMatches.filter((match) => match.kind === source.kind);
  const counterpartMatches = relatedMatches.filter((match) => match.kind !== source.kind);

  return [
    {
      title: pluralizeCategory(similarMatches.length, getCategoryLabel(source.kind, true)),
      locations: createReferenceLocations(similarMatches),
    },
    {
      title: pluralizeCategory(counterpartMatches.length, getCategoryLabel(source.kind, false)),
      locations: createReferenceLocations(counterpartMatches),
    },
  ];
}

export function registerEventIntelligence(context: vscode.ExtensionContext, eventIndex = new WorkspaceEventIndex()): vscode.Disposable[] {
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

      const currentApi = getApiAtPosition(document, position);
      const currentScriptSide = await eventIndex.getScriptSideForUri(document.uri);
      const desiredSides = getCurrentExecutionSides(currentApi, currentScriptSide);
      const names = await eventIndex.getNames();

      const filteredNames = await Promise.all(names.map(async (name) => {
        const matches = await eventIndex.getOccurrencesForName(name);
        const relevantMatches = matches.filter((match) => intersectsExecutionSides(getReachableSides(match), desiredSides));
        return relevantMatches.length > 0 ? name : undefined;
      }));

      return filteredNames.filter((name): name is string => name !== undefined).map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
        item.detail = 'Indexed FiveM event';
        item.insertText = name;
        return item;
      });
    },
  }, '"', "'");

  const referenceProvider = vscode.languages.registerReferenceProvider(selector, {
    async provideReferences(document, position, context) {
      const resolved = await resolveEventTargetsAtPosition(eventIndex, document, position);

      if (!resolved) {
        return undefined;
      }

      const filteredMatches = context.includeDeclaration
        ? resolved.relatedMatches
        : resolved.relatedMatches.filter((match) => !isSameOccurrence(match, resolved.occurrence));

      return createReferenceLocations(filteredMatches);
    },
  });

  const renameProvider = vscode.languages.registerRenameProvider(selector, {
    async prepareRename(document, position) {
      const resolved = await resolveEventTargetsAtPosition(eventIndex, document, position);

      if (!resolved) {
        throw new Error('Rename is only available on FiveM event string literals.');
      }

      return {
        range: resolved.occurrence.range,
        placeholder: resolved.occurrence.name,
      };
    },

    async provideRenameEdits(document, position, newName) {
      const trimmedName = newName.trim();

      if (trimmedName.length === 0) {
        throw new Error('Event name cannot be empty.');
      }

      const resolved = await resolveEventTargetsAtPosition(eventIndex, document, position);

      if (!resolved) {
        return undefined;
      }

      const workspaceEdit = new vscode.WorkspaceEdit();
      const documentsByUri = new Map<string, vscode.TextDocument>([[document.uri.toString(), document]]);

      for (const match of resolved.relatedMatches) {
        const key = match.uri.toString();
        let targetDocument = documentsByUri.get(key);

        if (!targetDocument) {
          targetDocument = await vscode.workspace.openTextDocument(match.uri);
          documentsByUri.set(key, targetDocument);
        }

        const quote = getLuaQuoteForOccurrence(targetDocument, match) ?? '"';
        workspaceEdit.replace(match.uri, match.range, escapeLuaStringLiteral(trimmedName, quote));
      }

      return workspaceEdit;
    },
  });

  const codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
    async provideCodeLenses(document) {
      const scriptSide = await eventIndex.getScriptSideForUri(document.uri);
      const documentOccurrences = extractEventOccurrences(document.getText(), document.uri, { scriptSide });

      if (documentOccurrences.length === 0) {
        return [];
      }

      const groupedLenses = await Promise.all(documentOccurrences.map(async (occurrence) => {
        const matches = await eventIndex.getOccurrencesForName(occurrence.name);
        const usageGroups = getUsageGroupsForOccurrence(occurrence, matches);

        return usageGroups.map((group) => new vscode.CodeLens(occurrence.range, {
          title: group.title,
          command: COMMAND_SHOW_EVENT_USAGES,
          arguments: [occurrence.uri, occurrence.range.start, group.locations, occurrence.name, group.title],
        }));
      }));

      return groupedLenses.flat();
    },
  });

  const showUsagesCommand = vscode.commands.registerCommand(
    COMMAND_SHOW_EVENT_USAGES,
    async (uri: vscode.Uri, position: vscode.Position, locations: vscode.Location[], eventName: string, categoryTitle?: string) => {
      if (locations.length === 0) {
        const scope = categoryTitle ? categoryTitle.toLowerCase() : 'indexed usages';
        await vscode.window.showInformationMessage(`No ${scope} found for '${eventName}'.`);
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
    renameProvider,
    codeLensProvider,
    showUsagesCommand,
    new vscode.Disposable(() => {
      while (watcherDisposables.length > 0) {
        watcherDisposables.pop()?.dispose();
      }
    }),
  ];
}
