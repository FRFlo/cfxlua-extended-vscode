import * as path from 'node:path';

export interface AddonPaths {
  pluginFilePath: string;
  basePluginFilePath: string;
  analysisDataFilePath: string;
  runtimeLibraryPath: string;
  cfxNativeLibraryPath: string;
  gtavNativeLibraryPath: string;
  rdr3NativeLibraryPath: string;
}

export function getAddonPaths(storagePath: string): AddonPaths {
  const libraryRootPath = path.join(storagePath, 'library');

  return {
    pluginFilePath: path.join(storagePath, 'plugin.lua'),
    basePluginFilePath: path.join(storagePath, 'base-plugin.lua'),
    analysisDataFilePath: path.join(storagePath, 'analysis-data.lua'),
    runtimeLibraryPath: path.join(libraryRootPath, 'runtime'),
    cfxNativeLibraryPath: path.join(libraryRootPath, 'natives', 'CFX-NATIVE'),
    gtavNativeLibraryPath: path.join(libraryRootPath, 'natives', 'GTAV'),
    rdr3NativeLibraryPath: path.join(libraryRootPath, 'natives', 'RDR3'),
  };
}
