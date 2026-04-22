import * as vscode from 'vscode';
import { installAddonAssets } from './assets';
import {
  COMMAND_REFRESH_RESOURCES,
  COMMAND_USE_GTAV,
  COMMAND_USE_RDR3,
  RESOURCE_DIRECTORY_NAME,
  RESOURCES_VIEW_ID,
} from './constants';
import { getSelectedGame } from './configuration';
import { registerEventIntelligence, WorkspaceEventIndex } from './eventIntelligence';
import { disableCfxLuaAddon, enableCfxLuaAddon } from './lifecycle';
import { ResourcesTreeDataProvider } from './resourcesTreeDataProvider';

let installedStoragePath: string | undefined;

async function activateGame(storagePath: string, game: 'GTAV' | 'RDR3'): Promise<void> {
  await enableCfxLuaAddon(storagePath, game);
}

function registerResourceWatchers(provider: ResourcesTreeDataProvider): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  const resetWatchers = () => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      const patterns = [
        RESOURCE_DIRECTORY_NAME,
        `${RESOURCE_DIRECTORY_NAME}/**`,
        `*/${RESOURCE_DIRECTORY_NAME}`,
        `*/${RESOURCE_DIRECTORY_NAME}/**`,
      ];

      for (const pattern of patterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspaceFolder, pattern),
        );

        watcher.onDidCreate(() => provider.refresh(), undefined, disposables);
        watcher.onDidChange(() => provider.refresh(), undefined, disposables);
        watcher.onDidDelete(() => provider.refresh(), undefined, disposables);

        disposables.push(watcher);
      }
    }
  };

  resetWatchers();

  const workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    resetWatchers();
    provider.refresh();
  });

  return new vscode.Disposable(() => {
    workspaceFoldersSubscription.dispose();

    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  installedStoragePath = await installAddonAssets(context);

  await activateGame(installedStoragePath, getSelectedGame());

  const eventIndex = new WorkspaceEventIndex();
  const resourcesTreeDataProvider = new ResourcesTreeDataProvider(eventIndex);
  const resourcesTreeView = vscode.window.createTreeView(RESOURCES_VIEW_ID, {
    treeDataProvider: resourcesTreeDataProvider,
    showCollapseAll: true,
  });
  const resourcesMessageSubscription = resourcesTreeDataProvider.onDidChangeMessage((message) => {
    resourcesTreeView.message = message;
  });
  const eventIndexSubscription = eventIndex.onDidInvalidate(() => {
    resourcesTreeDataProvider.refresh();
  });

  context.subscriptions.push(
    resourcesTreeView,
    resourcesMessageSubscription,
    eventIndexSubscription,
    registerResourceWatchers(resourcesTreeDataProvider),
    ...registerEventIntelligence(context, eventIndex),
    vscode.commands.registerCommand(COMMAND_USE_GTAV, async () => {
      await activateGame(installedStoragePath!, 'GTAV');
      await vscode.window.showInformationMessage('CfxLua now uses GTAV natives.');
    }),
    vscode.commands.registerCommand(COMMAND_USE_RDR3, async () => {
      await activateGame(installedStoragePath!, 'RDR3');
      await vscode.window.showInformationMessage('CfxLua now uses RDR3 natives.');
    }),
    vscode.commands.registerCommand(COMMAND_REFRESH_RESOURCES, () => {
      resourcesTreeDataProvider.refresh();
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (!installedStoragePath) {
    return;
  }

  await disableCfxLuaAddon(installedStoragePath);
}
