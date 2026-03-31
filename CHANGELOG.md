# Changelog

## [0.1.3] - 2026-03-31

### Added
- Dashboard guide document (GUIDE.md) with detailed walkthrough of each section
- Update instructions in README and Help page (CLI + in-session commands)
- Shell-styled command block in Help page
- Privacy section in README
- Improved `--data-only` and `--enable-auto` descriptions with bookmark/refresh tips
- Version display in sidebar now auto-injected from package.json at build time

### Changed
- "스코프(워크스페이스)" → "워크스페이스(스코프)" in Korean locale

## [0.1.2] - 2026-03-31

### Added
- Estimated cost calculation based on Anthropic API token pricing (per model: input/output/cache read/cache write)
- Cost stat cards: total cost, daily average cost, top 3 models by cost
- Cost column and total row in model breakdown table
- Cost breakdown insight in Token Insights section
- Cost formula explanation with collapsible model pricing table and source link (anthropic.com/pricing)
- Disclaimer note clarifying API-based estimate vs CLI subscription billing

### Fixed
- Period filter (7d/30d) now correctly counts today-inclusive (7d = today + 6 prior days)
- Hide tooltip on active period button (date range already shown below)

## [0.1.1] - 2026-03-31

### Fixed
- Fix missing `type: "command"` field in `--enable-auto` Stop hook registration, which caused Claude Code settings validation error on startup

## [0.1.0] - 2026-03-30

### Added
- Initial release as Claude Code plugin
- Harness overview dashboard with stats cards, category distribution, daily trend chart, popular skills, activity heatmap
- Token analytics: usage by model, daily trends, cache efficiency, prompt statistics, response latency, session analysis, hourly distribution
- Token analysis: task category classification (auto-classified at build time from skill/agent descriptions), tool context breakdown
- Structure page with hierarchical component flow diagram (context / event-driven / user-invoked groups) and file tree
- Help page with parameter reference and data parsing documentation
- 13 data parsers: configFiles, skills, agents, plugins, hooks, memory, mcpServers, rules, principles, commands, teams, plans, todos
- Multi-workspace support (global + per-project scopes)
- Dark/Light mode toggle
- i18n: English (built-in default) + Korean (locales/ko.json), auto-generated locale template for other languages
- `{{configDir}}` template variable for cross-platform path display
- Browser tab reuse on macOS (AppleScript: Chrome → Safari), Windows/Linux fallback
- Auto-refresh via Stop hook (`--enable-auto`)
- Persistent task category mapping (`task-categories.json`, user-editable)
- Single-file HTML output with inlined data (file:// protocol compatible)
