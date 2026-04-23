import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	escapeLuaStringLiteral,
	extractEventOccurrences,
	findEventOccurrenceAtPosition,
	getResourceEventGroupsFromOccurrences,
	getRelatedEventOccurrences,
	getUsageGroupsForOccurrence,
	isEventArgumentContext,
} from '../eventIntelligence';
import { normalizeGame } from '../game';
import { extractTopLevelGlobalDeclarations, getExecutionGroupEntries } from '../lualsSideEnvironment';
import { inferScriptSide, isResourcesDirectoryName } from '../resourceDiscovery';
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

	test('extractEventOccurrences keeps manifest-derived script side', () => {
		const uri = vscode.Uri.file('/tmp/client.lua');
		const [occurrence] = extractEventOccurrences(
			'TriggerClientEvent("bank:open", -1)',
			uri,
			{ scriptSide: 'server' },
		);

		assert.strictEqual(occurrence.scriptSide, 'server');
	});

	test('extractEventOccurrences ignores commented event APIs', () => {
		const uri = vscode.Uri.file('/tmp/client.lua');
		const occurrences = extractEventOccurrences([
			'-- TriggerEvent("commented")',
			'--[[ RegisterNetEvent("commented:block", function() end) ]]',
			'TriggerEvent("live:event")',
		].join('\n'), uri);

		assert.deepStrictEqual(
			occurrences.map((occurrence) => occurrence.name),
			['live:event'],
		);
	});

	test('extractEventOccurrences ignores long-bracket event literals for rename consistency', () => {
		const uri = vscode.Uri.file('/tmp/client.lua');
		const occurrences = extractEventOccurrences([
			'TriggerEvent([[ignored:event]])',
			'RegisterNetEvent("live:event", function() end)',
		].join('\n'), uri);

		assert.deepStrictEqual(
			occurrences.map((occurrence) => occurrence.name),
			['live:event'],
		);
	});

	test('inferScriptSide maps client, server and shared scripts from fxmanifest', () => {
		const manifest = [
			"client_scripts {'client/*.lua'}",
			"server_script 'server/main.lua'",
			"shared_script 'shared/init.lua'",
		].join('\n');

		assert.strictEqual(inferScriptSide('client/ui.lua', manifest), 'client');
		assert.strictEqual(inferScriptSide('server/main.lua', manifest), 'server');
		assert.strictEqual(inferScriptSide('shared/init.lua', manifest), 'shared');
		assert.strictEqual(inferScriptSide('misc/extra.lua', manifest), 'unknown');
	});

	test('inferScriptSide handles commented and multiline manifest directives', () => {
		const manifest = [
			'-- client_script "ignored.lua"',
			'client_scripts({',
			"  'client/*.lua',",
			'})',
			'--[[ shared_script "ignored_shared.lua" ]]',
			"shared_script 'shared/init.lua'",
		].join('\n');

		assert.strictEqual(inferScriptSide('client/main.lua', manifest), 'client');
		assert.strictEqual(inferScriptSide('shared/init.lua', manifest), 'shared');
		assert.strictEqual(inferScriptSide('ignored.lua', manifest), 'unknown');
	});

	test('inferScriptSide only uses top-level manifest table string entries', () => {
		const manifest = [
			'client_scripts({',
			"  'client/*.lua',",
			"  { 'nested/*.lua' },",
			"  helper('generated/*.lua'),",
			"  ['named'] = 'mapped/*.lua',",
			'})',
		].join('\n');

		assert.strictEqual(inferScriptSide('client/main.lua', manifest), 'client');
		assert.strictEqual(inferScriptSide('nested/file.lua', manifest), 'unknown');
		assert.strictEqual(inferScriptSide('generated/file.lua', manifest), 'unknown');
		assert.strictEqual(inferScriptSide('mapped/file.lua', manifest), 'unknown');
	});

	test('extractTopLevelGlobalDeclarations keeps only bare top-level globals', () => {
		const declarations = extractTopLevelGlobalDeclarations([
			'local ignored = true',
			'ClientState = {}',
			'function Boot() end',
			'local function hidden() end',
			'Nested = function()',
			'  LocalInside = true',
			'end',
			'Config.Value = true',
			'for i = 1, 3 do',
			'  LoopGlobal = i',
			'end',
		].join('\n'));

		assert.deepStrictEqual(
			declarations,
			[
				{ name: 'Boot', kind: 'function' },
				{ name: 'ClientState', kind: 'value' },
				{ name: 'Nested', kind: 'value' },
			],
		);
	});

	test('extractTopLevelGlobalDeclarations supports multi-assignments and comments', () => {
		const declarations = extractTopLevelGlobalDeclarations([
			'-- Cached = true',
			'First, Second = CreateThings()',
			'--[[ function Blocked() end ]]',
			'function Third() end',
		].join('\n'));

		assert.deepStrictEqual(
			declarations,
			[
				{ name: 'First', kind: 'value' },
				{ name: 'Second', kind: 'value' },
				{ name: 'Third', kind: 'function' },
			],
		);
	});

	test('getExecutionGroupEntries keeps shared scripts isolated from side-only globals', () => {
		const resourceRoot = vscode.Uri.file('/tmp/resources/example');
		const manifestUri = vscode.Uri.file('/tmp/resources/example/fxmanifest.lua');
		const entries = [
			{
				fileUri: vscode.Uri.file('/tmp/resources/example/client.lua'),
				resourceRoot,
				manifestUri,
				scriptSide: 'client' as const,
			},
			{
				fileUri: vscode.Uri.file('/tmp/resources/example/server.lua'),
				resourceRoot,
				manifestUri,
				scriptSide: 'server' as const,
			},
			{
				fileUri: vscode.Uri.file('/tmp/resources/example/shared.lua'),
				resourceRoot,
				manifestUri,
				scriptSide: 'shared' as const,
			},
		];

		assert.deepStrictEqual(
			getExecutionGroupEntries(entries, 'client').map((entry) => entry.fileUri.path),
			['/tmp/resources/example/client.lua', '/tmp/resources/example/shared.lua'],
		);

		assert.deepStrictEqual(
			getExecutionGroupEntries(entries, 'server').map((entry) => entry.fileUri.path),
			['/tmp/resources/example/server.lua', '/tmp/resources/example/shared.lua'],
		);

		assert.deepStrictEqual(
			getExecutionGroupEntries(entries, 'shared').map((entry) => entry.fileUri.path),
			['/tmp/resources/example/shared.lua'],
		);
	});

	test('getUsageGroupsForOccurrence splits similar handlers from triggers', () => {
		const uri = vscode.Uri.file('/tmp/server.lua');
		const occurrences = extractEventOccurrences([
			'RegisterNetEvent("bank:open", function() end)',
			'AddEventHandler("bank:open", function() end)',
			'TriggerEvent("bank:open")',
		].join('\n'), uri, { scriptSide: 'server' });
		const source = occurrences[0];
		const groups = getUsageGroupsForOccurrence(source, occurrences);

		assert.deepStrictEqual(
			groups.map((group) => [group.title, group.locations.length]),
			[
				['1 Receiver', 1],
				['1 Emitter', 1],
			],
		);
	});

	test('getUsageGroupsForOccurrence splits similar triggers from handlers', () => {
		const uri = vscode.Uri.file('/tmp/server.lua');
		const occurrences = extractEventOccurrences([
			'RegisterNetEvent("bank:open", function() end)',
			'TriggerEvent("bank:open")',
			'TriggerEvent("bank:open")',
		].join('\n'), uri, { scriptSide: 'server' });
		const source = occurrences[1];
		const groups = getUsageGroupsForOccurrence(source, occurrences);

		assert.deepStrictEqual(
			groups.map((group) => [group.title, group.locations.length]),
			[
				['1 Emitter', 1],
				['1 Receiver', 1],
			],
		);
	});

	test('getResourceEventGroupsFromOccurrences groups resource events into emitter and receiver buckets', () => {
		const uri = vscode.Uri.file('/tmp/server.lua');
		const occurrences = extractEventOccurrences([
			'TriggerEvent("bank:open")',
			'TriggerEvent("bank:open")',
			'RegisterNetEvent("bank:open", function() end)',
			'AddEventHandler("bank:close", function() end)',
		].join('\n'), uri, { scriptSide: 'server', resourceRoot: vscode.Uri.file('/tmp/resource') });
		const groups = getResourceEventGroupsFromOccurrences(occurrences);

		assert.deepStrictEqual(
			groups.map((group) => [group.title, group.events.map((eventEntry) => [eventEntry.name, eventEntry.locations.length])]),
			[
				['Emitter', [['bank:open', 2]]],
				['Receiver', [['bank:close', 1], ['bank:open', 1]]],
			],
		);
	});

	test('findEventOccurrenceAtPosition identifies event string literal ranges for rename targets', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'lua',
			content: 'RegisterNetEvent("bank:open", function() end)',
		});
		const occurrence = findEventOccurrenceAtPosition(document, new vscode.Position(0, 19), { scriptSide: 'server' });

		assert.ok(occurrence);
		assert.strictEqual(occurrence?.name, 'bank:open');
	});

	test('getRelatedEventOccurrences keeps rename scope side-aware', () => {
		const clientUri = vscode.Uri.file('/tmp/client.lua');
		const serverUri = vscode.Uri.file('/tmp/server.lua');
		const sourceOccurrences = extractEventOccurrences(
			'TriggerServerEvent("bank:open")',
			clientUri,
			{ scriptSide: 'client' },
		);
		const matches = [
			...sourceOccurrences,
			...extractEventOccurrences('RegisterNetEvent("bank:open", function() end)', serverUri, { scriptSide: 'server' }),
			...extractEventOccurrences('RegisterNetEvent("bank:open", function() end)', clientUri, { scriptSide: 'client' }),
		];

		const relatedMatches = getRelatedEventOccurrences(sourceOccurrences[0], matches);

		assert.deepStrictEqual(
			relatedMatches.map((occurrence) => [occurrence.uri.path, occurrence.scriptSide]),
			[
				['/tmp/client.lua', 'client'],
				['/tmp/server.lua', 'server'],
			],
		);
	});

	test('escapeLuaStringLiteral preserves the original quote style for rename edits', () => {
		assert.strictEqual(escapeLuaStringLiteral('bank:"open"', '"'), 'bank:\\"open\\"');
		assert.strictEqual(escapeLuaStringLiteral("bank:'open'", "'"), "bank:\\'open\\'");
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
