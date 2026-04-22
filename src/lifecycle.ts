import type { CfxGame } from './game';
import { getAddonPaths } from './paths';
import { clearLuaAddon, configureLuaAddon, setManagedLibraries, setSelectedGame } from './configuration';

export async function enableCfxLuaAddon(storagePath: string, game: CfxGame): Promise<void> {
  const addonPaths = getAddonPaths(storagePath);
  const selectedGame = await setSelectedGame(game);

  await configureLuaAddon(addonPaths);
  await setManagedLibraries(
    [
      addonPaths.runtimeLibraryPath,
      addonPaths.cfxNativeLibraryPath,
      selectedGame === 'RDR3' ? addonPaths.rdr3NativeLibraryPath : addonPaths.gtavNativeLibraryPath,
    ],
    true,
  );
}

export async function disableCfxLuaAddon(storagePath: string): Promise<void> {
  const addonPaths = getAddonPaths(storagePath);
  await clearLuaAddon(addonPaths);
  await setManagedLibraries([], false);
}
