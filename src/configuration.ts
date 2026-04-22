import * as vscode from 'vscode';
import {
  CFXLUA_SECTION,
  GAME_SETTING,
  IGNORED_DIRECTORIES,
  LEGACY_EXTENSION_ID,
  LUA_SECTION,
  NONSTANDARD_SYMBOLS,
  EXTENSION_NAME,
} from './constants';
import { type CfxGame, normalizeGame } from './game';
import type { AddonPaths } from './paths';

function getConfigurationTarget(): vscode.ConfigurationTarget {
  if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
    return vscode.ConfigurationTarget.Workspace;
  }

  return vscode.ConfigurationTarget.Global;
}

function getLuaConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(LUA_SECTION);
}

function getCfxConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CFXLUA_SECTION);
}

function mergeUnique(existingValues: string[], valuesToAdd: readonly string[]): string[] {
  const mergedValues = [...existingValues];

  for (const value of valuesToAdd) {
    if (!mergedValues.includes(value)) {
      mergedValues.push(value);
    }
  }

  return mergedValues;
}

function isManagedLibraryEntry(entry: string): boolean {
  return entry.includes(LEGACY_EXTENSION_ID) || entry.includes(EXTENSION_NAME);
}

export async function configureLuaAddon(paths: AddonPaths): Promise<void> {
  const target = getConfigurationTarget();
  const configuration = getLuaConfiguration();

  await configuration.update('runtime.version', 'Lua 5.4', target);
  await configuration.update('runtime.plugin', paths.pluginFilePath, target);

  const currentSymbols = configuration.get<string[]>('runtime.nonstandardSymbol') ?? [];
  const mergedSymbols = mergeUnique(currentSymbols, NONSTANDARD_SYMBOLS);
  await configuration.update('runtime.nonstandardSymbol', mergedSymbols, target);

  const ignoredDirectories = configuration.get<string[]>('workspace.ignoreDir') ?? [];
  const mergedIgnoredDirectories = mergeUnique(ignoredDirectories, IGNORED_DIRECTORIES);
  await configuration.update('workspace.ignoreDir', mergedIgnoredDirectories, target);
}

export async function clearLuaAddon(paths: AddonPaths): Promise<void> {
  const target = getConfigurationTarget();
  const configuration = getLuaConfiguration();
  const activePluginPath = configuration.get<string>('runtime.plugin');

  if (activePluginPath === paths.pluginFilePath || activePluginPath?.includes(LEGACY_EXTENSION_ID)) {
    await configuration.update('runtime.plugin', undefined, target);
  }
}

export async function setManagedLibraries(pathsToManage: string[], enabled: boolean): Promise<void> {
  const target = getConfigurationTarget();
  const configuration = getLuaConfiguration();
  const existingLibraries = configuration.get<string[]>('workspace.library') ?? [];
  const filteredLibraries = existingLibraries.filter((entry) => !isManagedLibraryEntry(entry));

  if (enabled) {
    for (const libraryPath of pathsToManage) {
      if (!filteredLibraries.includes(libraryPath)) {
        filteredLibraries.push(libraryPath);
      }
    }
  }

  await configuration.update('workspace.library', filteredLibraries, target);
}

export async function setSelectedGame(game: CfxGame): Promise<CfxGame> {
  const normalizedGame = normalizeGame(game);
  await getCfxConfiguration().update(GAME_SETTING, normalizedGame.toLowerCase(), getConfigurationTarget());
  return normalizedGame;
}

export function getSelectedGame(): CfxGame {
  const configuredGame = getCfxConfiguration().get<string>(GAME_SETTING);
  return normalizeGame(configuredGame);
}
