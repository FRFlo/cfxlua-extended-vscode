import { DEFAULT_GAME, SUPPORTED_GAMES } from './constants';

export type CfxGame = (typeof SUPPORTED_GAMES)[number];

export function normalizeGame(value: string | undefined): CfxGame {
  if (typeof value !== 'string') {
    return DEFAULT_GAME;
  }

  const normalizedValue = value.trim().toUpperCase();

  if (normalizedValue === 'RDR3') {
    return 'RDR3';
  }

  return 'GTAV';
}
