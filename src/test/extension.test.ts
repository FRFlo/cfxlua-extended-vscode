import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  extractEventOccurrences,
  isEventArgumentContext,
} from '../eventIntelligence';
import { normalizeGame } from '../game';
import { isResourcesDirectoryName } from '../resourceDiscovery';
import { sanitizeResourceSegment } from '../resourcesTreeDataProvider';

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

	test('extractEventOccurrences finds listeners and triggers', () => {
		const uri = vscode.Uri.file('/tmp/client.lua');
		const occurrences = extractEventOccurrences([
			'RegisterNetEvent("bank:open", function() end)',
			'AddEventHandler("bank:open", function() end)',
			'TriggerServerEvent("bank:open")',
		].join('\n'), uri);

		assert.deepStrictEqual(
			occurrences.map((occurrence) => [occurrence.api, occurrence.kind, occurrence.name]),
			[
				['RegisterNetEvent', 'listener', 'bank:open'],
				['AddEventHandler', 'listener', 'bank:open'],
				['TriggerServerEvent', 'trigger', 'bank:open'],
			],
		);
	});

	test('isEventArgumentContext detects unfinished first string arguments', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'lua',
			content: 'TriggerServerEvent("bank:'
		});

		assert.strictEqual(
			isEventArgumentContext(document, new vscode.Position(0, document.getText().length)),
			true,
		);
	});
});
