import * as vscode from 'vscode';
import {
  MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
  RESOURCE_MANIFEST_FILENAME,
} from './constants';
import {
  readChildDirectories,
  resolveSingleResourcesDirectory,
} from './resourceDiscovery';

type ResourceNodeKind = 'workspace' | 'folder' | 'resource';

export interface ResourceTreeNode {
  kind: ResourceNodeKind;
  label: string;
  originalName: string;
  uri: vscode.Uri;
  children: ResourceTreeNode[];
}

interface WorkspaceScanResult {
  nodes: ResourceTreeNode[];
  message?: string;
}

function compareNodes(left: ResourceTreeNode, right: ResourceTreeNode): number {
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
}

export function sanitizeResourceSegment(name: string): string {
  const bracketMatch = /^\[(.+)\]$/.exec(name);
  return bracketMatch?.[1] ?? name;
}

async function hasManifestFile(uri: vscode.Uri): Promise<boolean> {
  const entries = await vscode.workspace.fs.readDirectory(uri);

  return entries.some(
    ([entryName, entryType]) =>
      entryType === vscode.FileType.File && entryName.toLowerCase() === RESOURCE_MANIFEST_FILENAME,
  );
}

async function scanResourceSubtree(uri: vscode.Uri, name: string): Promise<ResourceTreeNode | undefined> {
  const hasManifest = await hasManifestFile(uri);

  if (hasManifest) {
    return {
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

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  readonly onDidChangeMessage = this.onDidChangeMessageEmitter.event;

  refresh(): void {
    this.cachedRootNodes = undefined;
    this.scanPromise = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ResourceTreeNode): vscode.TreeItem {
    const collapsibleState = element.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.id = element.uri.toString();
    item.resourceUri = element.uri;
    item.contextValue = element.kind;
    item.tooltip = new vscode.MarkdownString([
      `**${element.label}**`,
      '',
      element.uri.fsPath,
    ].join('\n'));
    item.description = element.kind === 'resource' ? 'resource' : undefined;
    item.iconPath = new vscode.ThemeIcon('folder');

    return item;
  }

  async getChildren(element?: ResourceTreeNode): Promise<ResourceTreeNode[]> {
    if (element) {
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
}
