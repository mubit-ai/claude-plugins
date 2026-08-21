---
name: plugin-tools-available
description: The MCP server boots inside the eval sandbox and the model can actually call it
tags: [surface, m8]
runs: 3
max_turns: 4
allowed_tools: [mcp__plugin_mubit-memory_mubit__mubit_status]
timeout_seconds: 180
---

Check whether your long-term memory system is connected and working, and report what you
find in one line. If you have no way to check, say exactly: NO MEMORY TOOLS.
