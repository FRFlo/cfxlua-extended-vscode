# CfxLua Extended

Modern IntelliSense support for the Lua runtime used by FiveM and RedM.

## Reference

### What this extension provides

- Runtime and environment globals for CfxLua, including `CreateThread`, events, promises, state bags, JSON helpers, and LuaGLM types.
- CFX native declarations plus switchable GTAV and RDR3 native libraries.
- Compatibility support for Cfx power-patch syntax through the bundled LuaLS plugin.
- Automatic Lua configuration for the required Lua extension.

### Requirements

- [Lua by sumneko](https://marketplace.visualstudio.com/items?itemName=sumneko.lua). This extension declares it as a dependency, so VS Code should prompt to install it when needed.

### Extension settings

This extension contributes the following setting:

- `cfxlua.game`: selects which game native set is added to Lua tooling. Supported values are `gtav` and `rdr3`.

### Commands

- `CfxLua: Use GTAV natives`
- `CfxLua: Use RDR3 natives`

## Explanation

The extension does not replace Lua language tooling. Instead, it augments LuaLS with Cfx-specific runtime libraries, native declarations, and a small compatibility plugin so the editor understands the APIs and syntax commonly used in FiveM and RedM resources.
