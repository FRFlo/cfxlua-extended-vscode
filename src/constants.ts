export const LEGACY_EXTENSION_ID = 'overextended.cfxlua-vscode';
export const EXTENSION_NAME = 'cfxlua-extended-vscode';

export const COMMAND_USE_GTAV = 'cfxlua.game.gtav';
export const COMMAND_USE_RDR3 = 'cfxlua.game.rdr3';
export const COMMAND_REFRESH_RESOURCES = 'cfxlua.resources.refresh';
export const COMMAND_SHOW_EVENT_USAGES = 'cfxlua.events.showUsages';

export const RESOURCES_VIEW_CONTAINER_ID = 'cfxlua-resources';
export const RESOURCES_VIEW_ID = 'cfxlua-resources-view';

export const CFXLUA_SECTION = 'cfxlua';
export const LUA_SECTION = 'Lua';
export const GAME_SETTING = 'game';

export const DEFAULT_GAME = 'GTAV';

export const RUNTIME_LIBRARY_FOLDERS = ['runtime', 'natives/CFX-NATIVE'] as const;

export const SUPPORTED_GAMES = ['GTAV', 'RDR3'] as const;

export const NONSTANDARD_SYMBOLS = [
  '/**/',
  '`',
  '+=',
  '-=',
  '*=',
  '/=',
  '<<=',
  '>>=',
  '&=',
  '|=',
  '^=',
] as const;

export const IGNORED_DIRECTORIES = [
  '.vscode',
  '.git',
  '.github',
  'node_modules',
  '\\[cfx\\]',
] as const;

export const RESOURCE_MANIFEST_FILENAME = 'fxmanifest.lua';
export const RESOURCE_DIRECTORY_NAME = 'resources';
export const MULTIPLE_SERVERS_UNSUPPORTED_MESSAGE = "Multiple servers aren't supported yet";

export const RESOURCE_SCAN_EXCLUDED_DIRECTORIES = [
  '.git',
  '.github',
  '.vscode',
  'node_modules',
] as const;
