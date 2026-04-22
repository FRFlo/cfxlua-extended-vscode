import * as assert from 'assert';
import { normalizeGame } from '../game';
import {
  isResourcesDirectoryName,
  sanitizeResourceSegment,
} from '../resourcesTreeDataProvider';

suite('CfxLua helpers', () => {
	test('normalizeGame falls back to GTAV', () => {
		assert.strictEqual(normalizeGame(undefined), 'GTAV');
		assert.strictEqual(normalizeGame('unknown'), 'GTAV');
	});

	test('normalizeGame accepts rdr3 case-insensitively', () => {
		assert.strictEqual(normalizeGame('rdr3'), 'RDR3');
		assert.strictEqual(normalizeGame('RDR3'), 'RDR3');
	});

	test('sanitizeResourceSegment removes surrounding brackets only', () => {
		assert.strictEqual(sanitizeResourceSegment('[local]'), 'local');
		assert.strictEqual(sanitizeResourceSegment('vehicles'), 'vehicles');
		assert.strictEqual(sanitizeResourceSegment('[test'), '[test');
	});

	test('isResourcesDirectoryName only accepts resources', () => {
		assert.strictEqual(isResourcesDirectoryName('resources'), true);
		assert.strictEqual(isResourcesDirectoryName('Resources'), false);
		assert.strictEqual(isResourcesDirectoryName('[resources]'), false);
	});
});
