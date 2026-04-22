import * as assert from 'assert';
import { normalizeGame } from '../game';

suite('CfxLua helpers', () => {
	test('normalizeGame falls back to GTAV', () => {
		assert.strictEqual(normalizeGame(undefined), 'GTAV');
		assert.strictEqual(normalizeGame('unknown'), 'GTAV');
	});

	test('normalizeGame accepts rdr3 case-insensitively', () => {
		assert.strictEqual(normalizeGame('rdr3'), 'RDR3');
		assert.strictEqual(normalizeGame('RDR3'), 'RDR3');
	});
});
