---
name: doctor-on-empty-memory
description: A memory-is-broken complaint routes to a diagnostic surface rather than a guess
tags: [m8, skills]
runs: 3
max_turns: 8
allowed_tools: [Skill, Bash, mcp__plugin_mubit-memory_mubit__mubit_diagnose, mcp__plugin_mubit-memory_mubit__mubit_status]
timeout_seconds: 300
---

My project memory looks completely empty — nothing is being recalled and I do not know
whether it is even connected. Find out what is actually wrong.
