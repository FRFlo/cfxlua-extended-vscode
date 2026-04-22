import * as vscode from 'vscode';
import {
  MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
  RESOURCE_DIRECTORY_NAME,
  RESOURCE_MANIFEST_FILENAME,
  RESOURCE_SCAN_EXCLUDED_DIRECTORIES,
} from './constants';

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

function isExcludedDirectory(name: string): boolean {
  return RESOURCE_SCAN_EXCLUDED_DIRECTORIES.includes(name as (typeof RESOURCE_SCAN_EXCLUDED_DIRECTORIES)[number]);
}

export function sanitizeResourceSegment(name: string): string {
  const bracketMatch = /^\[(.+)\]$/.exec(name);
  return bracketMatch?.[1] ?? name;
}

export function isResourcesDirectoryName(name: string): boolean {
  return name === RESOURCE_DIRECTORY_NAME;
}

async function readDirectoryEntries(uri: vscode.Uri): Promise<readonly [string, vscode.FileType][]> {
  return vscode.workspace.fs.readDirectory(uri);
}

async function readChildDirectories(uri: vscode.Uri): Promise<Array<{ name: string; uri: vscode.Uri }>> {
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

async function resolveResourcesDirectories(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const directories = await readChildDirectories(folder.uri);
  const candidates = directories
    .filter((directory) => isResourcesDirectoryName(directory.name))
    .map((directory) => directory.uri);

  const nestedCandidates = await Promise.all(
    directories
      .filter((directory) => directory.name !== RESOURCE_DIRECTORY_NAME)
      .map(async (directory) => {
        const childDirectories = await readChildDirectories(directory.uri);
        const resourcesDirectory = childDirectories.find((child) => isResourcesDirectoryName(child.name));

        return resourcesDirectory?.uri;
      }),
  );

  return [...candidates, ...nestedCandidates.filter((uri): uri is vscode.Uri => uri !== undefined)];
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
  const resourcesDirectories = await resolveResourcesDirectories(folder);

  if (resourcesDirectories.length === 0) {
    return { nodes: [] };
  }

  if (resourcesDirectories.length > 1) {
    return {
      nodes: [],
      message: MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE,
    };
  }

  return {
    nodes: await scanResourcesDirectory(resourcesDirectories[0]),
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
