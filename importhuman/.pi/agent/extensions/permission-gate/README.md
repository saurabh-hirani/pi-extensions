# Permission Gate

`permission-gate` is a local pi extension that adds a policy-and-consent layer around tool usage.

By default, it treats the directory where pi started as the session root and allows normal file access only within that root. Access outside that root can be allowed via config or approved interactively for the current session.

## What it does

It applies different rules depending on the tool category.

### Path-aware tools
Currently this extension treats these tools as path-aware:

- `read`
- `write`
- `edit`

Policy order:

1. `disallowedPaths` → hard deny
2. session-approved file or directory → allow
3. `sensitivePaths` → prompt
4. path inside the session root → allow
5. `allowedPaths` → allow
6. anything else → prompt

Interactive path prompts offer:

- Allow once
- Allow file for session
- Allow directory for session
- Deny

### Bash
Bash is handled with command-pattern rules, not filesystem path analysis.

Policy order:

1. `disallowedBashCommands` → hard deny
2. session-approved exact command → allow
3. `allowedBashCommands` → allow
4. everything else, including `sensitiveBashCommands` matches → prompt

Interactive bash prompts offer:

- Allow once
- Allow this command for session
- Deny

### Other tools
For non-path-aware, non-bash tools:

1. `disallowedTools` → hard deny
2. session-approved tool → allow
3. `allowedTools` → allow
4. `sensitiveTools` → prompt
5. otherwise follow `unknownToolsPolicy`

Interactive tool prompts offer:

- Allow once
- Allow tool for session
- Deny

### `/permissions` command
The extension registers:

- `/permissions`

This shows:

- session root
- configured path, bash, and tool policy buckets
- session-approved files
- session-approved directories
- session-approved bash commands
- session-approved tools

It also lets you clear temporary session approvals.

## Config

Configuration lives in:

- `config.jsonc`

Current schema:

```jsonc
{
  "allowedPaths": [],
  "sensitivePaths": [],
  "disallowedPaths": [],

  "allowedBashCommands": [],
  "sensitiveBashCommands": [],
  "disallowedBashCommands": [],

  "allowedTools": [],
  "sensitiveTools": [],
  "disallowedTools": [],

  "unknownToolsPolicy": "prompt"
}
```

## Path rule semantics

- relative path patterns are resolved relative to the session root
- absolute path patterns are matched as absolute paths
- `~` expands to the user home directory
- glob matching is supported
- `disallowedPaths` always wins, even if a parent directory is otherwise allowed

## Limitations

This is not a sandbox. It is a guardrail layer.

Known limitations:

- Only `read`, `write`, and `edit` are currently treated as path-aware.
- Bash is not path-scoped. It uses command-pattern matching only.
- Unknown/custom tools can only be controlled at the tool level unless explicit path-aware support is added.
- Matching is lexical, not fully symlink-aware.
- Glob behavior is intentionally simpler than full `.gitignore` semantics.
- Config is loaded when the extension starts, so config changes require reload/restart to take effect.

## Notes

This extension is meant to reduce accidental overreach by pi, especially when working outside the current project root or around sensitive files.
