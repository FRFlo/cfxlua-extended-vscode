local str_find = string.find
local str_sub = string.sub
local str_gmatch = string.gmatch

local basePlugin = nil
local analysisData = nil
local analysisDataPath = nil
local basePluginPath = nil
local analysisLastLoadedAt = nil

local function getPluginDirectory()
	local source = debug.getinfo(1, 'S').source

	if str_sub(source, 1, 1) == '@' then
		source = str_sub(source, 2)
	end

	return source:match('^(.*)[\\/][^\\/]+$') or '.'
end

local function getBasePluginPath()
	if basePluginPath == nil then
		basePluginPath = getPluginDirectory() .. '/base-plugin.lua'
	end

	return basePluginPath
end

local function getAnalysisDataPath()
	if analysisDataPath == nil then
		analysisDataPath = getPluginDirectory() .. '/analysis-data.lua'
	end

	return analysisDataPath
end

local function loadBasePlugin()
	if basePlugin ~= nil then
		return basePlugin
	end

	local chunk = loadfile(getBasePluginPath())

	if chunk == nil then
		basePlugin = {}
		return basePlugin
	end

	local previousOnSetText = OnSetText
	local ok, result = pcall(chunk)
	local loadedOnSetText = OnSetText
	OnSetText = previousOnSetText

	if not ok then
		basePlugin = {}
		return basePlugin
	end

	basePlugin = {
		OnSetText = type(loadedOnSetText) == 'function' and loadedOnSetText or nil,
		result = result,
	}

	return basePlugin
end

local function loadAnalysisData()
	local now = os.clock()

	if analysisData ~= nil and analysisLastLoadedAt ~= nil and (now - analysisLastLoadedAt) < 1 then
		return analysisData
	end

	analysisLastLoadedAt = now
	local chunk = loadfile(getAnalysisDataPath())

	if chunk == nil then
		analysisData = { files = {} }
		return analysisData
	end

	local ok, result = pcall(chunk)

	if not ok or type(result) ~= 'table' then
		analysisData = { files = {} }
		return analysisData
	end

	analysisData = result
	analysisData.files = analysisData.files or {}
	return analysisData
end

local function appendDiff(diffs, count, diff)
	count = count + 1
	diffs[count] = diff
	return count
end

local function normalizeBaseResult(result)
	if result == nil then
		return {}, 0
	end

	if type(result) == 'string' then
		return {
			{
				start = 1,
				finish = 0,
				text = result,
			},
		}, 1
	end

	if type(result) ~= 'table' then
		return {}, 0
	end

	return result, #result
end

--- @param uri string
--- @param text string
--- @return { start: integer, finish: integer, text: string }[] | string | nil
function OnSetText(uri, text)
	local baseResult = nil
	local baseOnSetText = loadBasePlugin().OnSetText

	if type(baseOnSetText) == 'function' then
		baseResult = baseOnSetText(uri, text)
	end

	local diffs, count = normalizeBaseResult(baseResult)

	if str_find(uri, '[\\/]%.vscode[\\/]') or str_sub(text, 1, 8) == '---@meta' then
		return diffs
	end

	if str_sub(text, 1, 4) == 'FXAP' then
		return type(baseResult) == 'string' and baseResult or ''
	end

	local prelude = loadAnalysisData().files[uri]

	if type(prelude) == 'string' and prelude ~= '' then
		count = appendDiff(diffs, count, {
			start = 1,
			finish = 0,
			text = prelude,
		})
	end

	return diffs
end
