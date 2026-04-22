import * as vscode from 'vscode';
import { installAddonAssets } from './assets';
import { COMMAND_USE_GTAV, COMMAND_USE_RDR3 } from './constants';
import { getSelectedGame } from './configuration';
import { disableCfxLuaAddon, enableCfxLuaAddon } from './lifecycle';

let installedStoragePath: string | undefined;

async function activateGame(storagePath: string, game: 'GTAV' | 'RDR3'): Promise<void> {
  await enableCfxLuaAddon(storagePath, game);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  installedStoragePath = await installAddonAssets(context);

  await activateGame(installedStoragePath, getSelectedGame());

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_USE_GTAV, async () => {
      await activateGame(installedStoragePath!, 'GTAV');
      await vscode.window.showInformationMessage('CfxLua now uses GTAV natives.');
    }),
    vscode.commands.registerCommand(COMMAND_USE_RDR3, async () => {
      await activateGame(installedStoragePath!, 'RDR3');
      await vscode.window.showInformationMessage('CfxLua now uses RDR3 natives.');
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (!installedStoragePath) {
    return;
  }

  await disableCfxLuaAddon(installedStoragePath);
}
