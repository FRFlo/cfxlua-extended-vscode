import * as vscode from 'vscode';
import {
  MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
} from './constants';
import { ResourceEventGroup, WorkspaceEventIndex } from './eventIntelligence';
import {
  hasResourceManifest,
  readChildDirectories,
  resolveSingleResourcesDirectory,
} from './resourceDiscovery';

type ResourceNodeKind = 'workspace' | 'folder' | 'resource' | 'eventRoot' | 'eventGroup' | 'eventName';

export interface ResourceTreeNode {
  id: string;
  kind: ResourceNodeKind;
  label: string;
  originalName: string;
  uri: vscode.Uri;
  children: ResourceTreeNode[];
  group?: ResourceEventGroup;
  eventLocations?: vscode.Location[];
}

interface WorkspaceScanResult {
  nodes: ResourceTreeNode[];
  message?: string;
}

function compareNodes(left: ResourceTreeNode, right: ResourceTreeNode): number {
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
}

function pluralizeUsage(count: number): string {
  return `${count} ${count === 1 ? 'usage' : 'usages'}`;
}

export function sanitizeResourceSegment(name: string): string {
  const bracketMatch = /^\[(.+)\]$/.exec(name);
  return bracketMatch?.[1] ?? name;
}

async function scanResourceSubtree(uri: vscode.Uri, name: string): Promise<ResourceTreeNode | undefined> {
  const hasManifest = await hasResourceManifest(uri);

  if (hasManifest) {
    return {
      id: uri.toString(),
      kind: 'resource',
      label: sanitizeResourceSegment(name),
      originalName: name,
      uri,
      children: [],
    };
  }

  const childDirectories = await readChildDirectories(uri);

  const childNodes = (
    await Promise.all(childDirectories.map((directory) => scanResourceSubtree(directory.uri, directory.name)))
  )
    .filter((node): node is ResourceTreeNode => node !== undefined)
    .sort(compareNodes);

  if (childNodes.length === 0) {
    return undefined;
  }

  return {
    id: uri.toString(),
    kind: 'folder',
    label: sanitizeResourceSegment(name),
    originalName: name,
    uri,
    children: childNodes,
  };
}

async function scanResourcesDirectory(resourcesDirectory: vscode.Uri): Promise<ResourceTreeNode[]> {
  const childDirectories = await readChildDirectories(resourcesDirectory);

  return (
    await Promise.all(
      childDirectories.map((directory) => scanResourceSubtree(directory.uri, directory.name)),
    )
  )
    .filter((node): node is ResourceTreeNode => node !== undefined)
    .sort(compareNodes);
}

async function scanWorkspaceFolder(folder: vscode.WorkspaceFolder): Promise<WorkspaceScanResult> {
  const resolution = await resolveSingleResourcesDirectory(folder);

  if (!resolution.uri && !resolution.message) {
    return { nodes: [] };
  }

  if (resolution.message === MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE) {
    return {
      nodes: [],
      message: MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
    };
  }

  return {
    nodes: await scanResourcesDirectory(resolution.uri!),
  };
}

export class ResourcesTreeDataProvider implements vscode.TreeDataProvider<ResourceTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ResourceTreeNode | undefined | void>();
  private readonly onDidChangeMessageEmitter = new vscode.EventEmitter<string | undefined>();
  private cachedRootNodes: ResourceTreeNode[] | undefined;
  private scanPromise: Promise<ResourceTreeNode[]> | undefined;
  private viewMessage: string | undefined;

  constructor(private readonly eventIndex: WorkspaceEventIndex) {}

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  readonly onDidChangeMessage = this.onDidChangeMessageEmitter.event;

  refresh(): void {
    this.cachedRootNodes = undefined;
    this.scanPromise = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ResourceTreeNode): vscode.TreeItem {
    let collapsibleState = element.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    if (element.kind === 'resource' || element.kind === 'eventRoot' || element.kind === 'eventGroup') {
      collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }

    if (element.kind === 'eventName') {
      collapsibleState = vscode.TreeItemCollapsibleState.None;
    }

    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.id = element.id;
    item.contextValue = element.kind;

    switch (element.kind) {
      case 'workspace':
      case 'folder':
      case 'resource': {
        item.resourceUri = element.uri;
        item.tooltip = new vscode.MarkdownString([
          `**${element.label}**`,
          '',
          element.uri.fsPath,
        ].join('\n'));
        item.description = element.kind === 'resource' ? 'resource' : undefined;
        item.iconPath = new vscode.ThemeIcon('folder');
        break;
      }
      case 'eventRoot': {
        item.tooltip = new vscode.MarkdownString('**Triggers**\n\nIndexed event usage groups for this resource.');
        item.iconPath = new vscode.ThemeIcon('symbol-event');
        break;
      }
      case 'eventGroup': {
        item.tooltip = new vscode.MarkdownString(`**${element.label}**\n\n${element.group?.events.length ?? 0} indexed events`);
        item.description = pluralizeUsage(element.group?.locations.length ?? 0);
        item.iconPath = new vscode.ThemeIcon(element.group?.kind === 'trigger' ? 'arrow-up' : 'arrow-down');
        break;
      }
      case 'eventName': {
        item.tooltip = new vscode.MarkdownString([
          `**${element.label}**`,
          '',
          pluralizeUsage(element.eventLocations?.length ?? 0),
        ].join('\n'));
        item.description = pluralizeUsage(element.eventLocations?.length ?? 0);
        item.iconPath = new vscode.ThemeIcon('symbol-event');

        if (element.eventLocations && element.eventLocations.length > 0) {
          const [firstLocation] = element.eventLocations;
          item.command = {
            title: 'Show event usages',
            command: 'editor.action.showReferences',
            arguments: [firstLocation.uri, firstLocation.range.start, element.eventLocations],
          };
        }
        break;
      }
    }

    return item;
  }

  async getChildren(element?: ResourceTreeNode): Promise<ResourceTreeNode[]> {
    if (element) {
      if (element.kind === 'resource') {
        return this.getResourceChildren(element);
      }

      if (element.kind === 'eventRoot') {
        return this.getEventGroupNodes(element);
      }

      if (element.kind === 'eventGroup') {
        return this.getEventNameNodes(element);
      }

      return element.children;
    }

    return this.getRootNodes();
  }

  private async getRootNodes(): Promise<ResourceTreeNode[]> {
    if (this.cachedRootNodes) {
      return this.cachedRootNodes;
    }

    if (!this.scanPromise) {
      this.scanPromise = this.scanWorkspace();
    }

    this.cachedRootNodes = await this.scanPromise;
    this.scanPromise = undefined;

    return this.cachedRootNodes;
  }

  private async scanWorkspace(): Promise<ResourceTreeNode[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (folders.length === 0) {
      this.setMessage(undefined);
      return [];
    }

    if (folders.length === 1) {
      const result = await scanWorkspaceFolder(folders[0]);
      this.setMessage(result.message);
      return result.nodes;
    }

    let message: string | undefined;

    const workspaceNodes = (
      await Promise.all<ResourceTreeNode | undefined>(
        folders.map(async (folder) => {
          const result = await scanWorkspaceFolder(folder);

          if (!message && result.message) {
            message = result.message;
          }

          if (result.nodes.length === 0) {
            return undefined;
          }

          const workspaceNode: ResourceTreeNode = {
            id: folder.uri.toString(),
            kind: 'workspace',
            label: sanitizeResourceSegment(folder.name),
            originalName: folder.name,
            uri: folder.uri,
            children: result.nodes,
          };

          return workspaceNode;
        }),
      )
    )
      .filter((node): node is ResourceTreeNode => node !== undefined)
      .sort(compareNodes);

    this.setMessage(message);

    return workspaceNodes;
  }

  private setMessage(message: string | undefined): void {
    if (this.viewMessage === message) {
      return;
    }

    this.viewMessage = message;
    this.onDidChangeMessageEmitter.fire(message);
  }

  private async getResourceChildren(resourceNode: ResourceTreeNode): Promise<ResourceTreeNode[]> {
    const eventGroups = await this.eventIndex.getResourceEventGroups(resourceNode.uri);
    const hasEmitterGroup = eventGroups.some((group) => group.kind === 'trigger');

    if (!hasEmitterGroup) {
      return resourceNode.children;
    }

    return [
      ...resourceNode.children,
      {
        id: `${resourceNode.id}#triggers`,
        kind: 'eventRoot',
        label: 'Triggers',
        originalName: 'Triggers',
        uri: resourceNode.uri,
        children: [],
      },
    ];
  }

  private async getEventGroupNodes(eventRootNode: ResourceTreeNode): Promise<ResourceTreeNode[]> {
    const groups = await this.eventIndex.getResourceEventGroups(eventRootNode.uri);

    return groups.map((group) => ({
      id: `${eventRootNode.id}/${group.kind}`,
      kind: 'eventGroup',
      label: group.title,
      originalName: group.title,
      uri: eventRootNode.uri,
      children: [],
      group,
    }));
  }

  private getEventNameNodes(eventGroupNode: ResourceTreeNode): ResourceTreeNode[] {
    const group = eventGroupNode.group;

    if (!group) {
      return [];
    }

    return group.events.map((eventEntry) => ({
      id: `${eventGroupNode.id}/${eventEntry.name}`,
      kind: 'eventName',
      label: eventEntry.name,
      originalName: eventEntry.name,
      uri: eventGroupNode.uri,
      children: [],
      eventLocations: eventEntry.locations,
    }));
  }
}
