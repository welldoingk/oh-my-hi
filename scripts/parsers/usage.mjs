// usage.mjs — history, transcript, stats-cache parser
import fs from 'fs';
import path from 'path';

// Built-in Claude CLI slash commands (to be filtered out)
const BUILTIN_COMMANDS = new Set([
  'clear', 'exit', 'help', 'config', 'login', 'logout', 'doctor',
  'mcp', 'model', 'memory', 'status', 'statusline', 'init', 'ide',
  'summary', 'usage', 'cost', 'stats', 'plugin', 'skills', 'context',
  'sandbox', 'compact',
]);

/**
 * Determine if a display string is a user-defined slash command
 * - Must start with /
 * - Excludes built-in commands
 * - Excludes paths (/Users/...) and typos (non-alpha patterns like /celar)
 */
function isUserCommand(display) {
  if (!display || !display.startsWith('/')) return false;

  // Exclude path patterns (multiple slashes or /Users/, /tmp/, etc.)
  if (display.startsWith('/Users/') || display.startsWith('/tmp/') || display.startsWith('/var/')) return false;
  if (/^\/[a-z]:[/\\]/i.test(display)) return false; // Windows path

  // Extract command name (up to whitespace or newline)
  const name = display.slice(1).split(/[\s\n]/)[0].toLowerCase();

  // Exclude empty names
  if (!name) return false;

  // Exclude built-in commands
  if (BUILTIN_COMMANDS.has(name)) return false;

  // Allow only alphanumeric/hyphen/colon/dot (typical command names)
  if (!/^[a-z0-9:.\-_]+$/i.test(name)) return false;

  return true;
}

/**
 * Calculate cutoffMs: days=0 returns 0 (all), days>0 returns now - days*24h
 */
function calcCutoff(days) {
  if (!days || days <= 0) return 0;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/**
 * Parse user commands from history.jsonl
 */
function parseCommands(configDir, cutoffMs) {
  const histPath = path.join(configDir, 'history.jsonl');
  if (!fs.existsSync(histPath)) return [];

  const commands = [];
  const raw = fs.readFileSync(histPath, 'utf8');

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (!entry.display || !entry.timestamp) continue;
      if (cutoffMs && entry.timestamp < cutoffMs) continue;
      if (!isUserCommand(entry.display)) continue;

      const name = entry.display.slice(1).split(/[\s\n]/)[0].toLowerCase();
      commands.push({
        name,
        timestamp: entry.timestamp,
        project: entry.project ?? null,
        sessionId: entry.sessionId ?? null,
      });
    } catch {
      // Skip on parse failure
    }
  }

  return commands;
}

/**
 * Parse Skill/Agent tool_use entries from transcript JSONL
 * @param {string} jsonlPath
 * @param {number} cutoffMs
 * @returns {{ skills: Array, agents: Array }}
 */
function parseTranscriptFile(jsonlPath, cutoffMs) {
  const skills = [];
  const agents = [];
  const mcpCalls = [];
  const tokenEntries = [];
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return { skills, agents, mcpCalls, tokenEntries };
  }

  // Track last active context per session for token attribution
  const sessionContext = {}; // sessionId → { type, name }
  const promptStats = []; // user prompt stats
  const latencyEntries = []; // response latency
  const lastHumanTs = {}; // sessionId → timestamp of last human message

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);

      // Collect user prompt stats + track human timestamp for latency
      if (entry.type === 'human' || entry.type === 'user') {
        const tsMs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (cutoffMs && tsMs < cutoffMs) continue;
        const sid = entry.sessionId ?? '_default';
        if (tsMs) lastHumanTs[sid] = tsMs;
        const msg = entry.message;
        let charLen = 0;
        if (typeof msg === 'string') {
          charLen = msg.length;
        } else if (msg && typeof msg === 'object') {
          const content = msg.content;
          if (typeof content === 'string') charLen = content.length;
          else if (Array.isArray(content)) {
            content.forEach(c => { if (c.type === 'text' && c.text) charLen += c.text.length; });
          }
        }
        if (charLen > 0) {
          promptStats.push({ timestamp: tsMs || entry.timestamp, charLen, sessionId: entry.sessionId ?? null });
        }
        continue;
      }

      if (entry.type !== 'assistant') continue;

      const tsMs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      if (cutoffMs && tsMs < cutoffMs) continue;

      const sid = entry.sessionId ?? '_default';

      // Response latency: diff from last human message
      if (lastHumanTs[sid] && tsMs) {
        const latencyMs = tsMs - lastHumanTs[sid];
        if (latencyMs > 0 && latencyMs < 600000) { // max 10min, filter outliers
          latencyEntries.push({
            timestamp: tsMs,
            latencyMs,
            model: entry.message?.model || 'unknown',
            sessionId: entry.sessionId ?? null,
          });
        }
        delete lastHumanTs[sid]; // consume, avoid double counting
      }

      // Scan tool_use first to update context
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type !== 'tool_use') continue;
          if (item.name === 'Skill') {
            const skillName = item.input?.skill;
            if (skillName) {
              sessionContext[sid] = { type: 'skill', name: skillName };
              skills.push({ name: skillName, timestamp: tsMs || entry.timestamp, sessionId: entry.sessionId ?? null });
            }
          } else if (item.name === 'Agent') {
            const agentName = item.input?.subagent_type ?? item.input?.description ?? 'unknown';
            sessionContext[sid] = { type: 'agent', name: agentName };
            agents.push({ name: agentName, timestamp: tsMs || entry.timestamp, sessionId: entry.sessionId ?? null });
          } else if (item.name.startsWith('mcp__')) {
            const parts = item.name.split('__');
            const serverName = parts[1] || item.name;
            sessionContext[sid] = { type: 'mcp', name: serverName };
            mcpCalls.push({ name: serverName, tool: item.name, timestamp: tsMs || entry.timestamp, sessionId: entry.sessionId ?? null });
          } else {
            // Built-in tools (Read, Write, Edit, Bash, Grep, Glob, etc.)
            sessionContext[sid] = { type: 'tool', name: item.name };
          }
        }
      }

      // Token usage with context
      const usage = entry.message?.usage;
      if (usage) {
        const ctx = sessionContext[sid] || { type: 'general', name: 'conversation' };
        tokenEntries.push({
          timestamp: tsMs || entry.timestamp,
          model: entry.message?.model || 'unknown',
          inputTokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
          outputTokens: usage.output_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          cacheCreation: usage.cache_creation_input_tokens || 0,
          rawInput: usage.input_tokens || 0,
          context: ctx.type,
          contextName: ctx.name,
          sessionId: entry.sessionId ?? null,
        });
      }
    } catch {
      // Skip on parse failure
    }
  }

  return { skills, agents, mcpCalls, tokenEntries, promptStats, latencyEntries };
}

/**
 * Parse all transcript JSONL files under projects/
 * Pass 1: fast filtering by file mtime
 * Pass 2: precise filtering by in-file timestamp
 */
function parseTranscripts(configDir, cutoffMs) {
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return { skills: [], agents: [] };

  const allSkills = [];
  const allAgents = [];
  const allMcpCalls = [];
  const allTokenEntries = [];
  const allPromptStats = [];
  const allLatencyEntries = [];

  // Subtract one day from cutoffMs for mtime filter margin
  const mtimeCutoff = cutoffMs ? cutoffMs - 24 * 60 * 60 * 1000 : 0;

  for (const projectDir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;

    const projPath = path.join(projectsDir, projectDir.name);
    let files;
    try {
      files = fs.readdirSync(projPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;

      const filePath = path.join(projPath, file.name);

      // Pass 1 filter: file mtime
      if (mtimeCutoff) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < mtimeCutoff) continue;
        } catch {
          continue;
        }
      }

      // Pass 2 filter: in-file timestamp (handled inside parseTranscriptFile)
      const { skills, agents, mcpCalls, tokenEntries, promptStats, latencyEntries } = parseTranscriptFile(filePath, cutoffMs);
      allSkills.push(...skills);
      allAgents.push(...agents);
      allMcpCalls.push(...mcpCalls);
      allTokenEntries.push(...tokenEntries);
      allPromptStats.push(...promptStats);
      allLatencyEntries.push(...latencyEntries);
    }
  }

  return { skills: allSkills, agents: allAgents, mcpCalls: allMcpCalls, tokenEntries: allTokenEntries, promptStats: allPromptStats, latencyEntries: allLatencyEntries };
}

/**
 * Parse dailyActivity from stats-cache.json
 */
function parseDailyActivity(configDir, cutoffMs) {
  const cachePath = path.join(configDir, 'stats-cache.json');
  if (!fs.existsSync(cachePath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const activities = data.dailyActivity ?? [];

    if (!cutoffMs) return activities;

    const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
    return activities.filter(a => a.date >= cutoffDate);
  } catch {
    return [];
  }
}

/**
 * Parse usage data
 * @param {string} configDir - Claude config root path
 * @param {number} days - 0 for all, >0 for last N days
 * @returns {{
 *   commands: Array<{name, timestamp, project, sessionId}>,
 *   skills: Array<{name, timestamp, sessionId}>,
 *   agents: Array<{name, timestamp, sessionId}>,
 *   mcpCalls: Array<{name, tool, timestamp, sessionId}>,
 *   tokenEntries: Array<{timestamp, model, inputTokens, outputTokens, cacheRead, cacheCreation, rawInput}>,
 *   dailyActivity: Array<{date, messageCount, sessionCount, toolCallCount}>,
 * }}
 */
export function parseUsage(configDir, days = 0, projectDir = null) {
  const cutoffMs = calcCutoff(days);

  const commands = parseCommands(configDir, cutoffMs);
  let transcriptResult;
  if (projectDir) {
    // Project-specific: parse only the project's transcript directory
    transcriptResult = parseProjectTranscripts(projectDir, cutoffMs);
  } else {
    transcriptResult = parseTranscripts(configDir, cutoffMs);
  }
  const { skills, agents, mcpCalls, tokenEntries, promptStats, latencyEntries } = transcriptResult;
  const dailyActivity = parseDailyActivity(configDir, cutoffMs);

  return { commands, skills, agents, mcpCalls, tokenEntries, promptStats, latencyEntries, dailyActivity };
}

/**
 * Parse transcripts from a single project directory only
 */
function parseProjectTranscripts(projDirPath, cutoffMs) {
  const allSkills = [];
  const allAgents = [];
  const allMcpCalls = [];
  const allTokenEntries = [];
  const allPromptStats = [];
  const allLatencyEntries = [];

  if (!fs.existsSync(projDirPath)) {
    return { skills: allSkills, agents: allAgents, mcpCalls: allMcpCalls, tokenEntries: allTokenEntries, promptStats: allPromptStats, latencyEntries: allLatencyEntries };
  }

  const mtimeCutoff = cutoffMs ? cutoffMs - 24 * 60 * 60 * 1000 : 0;

  // Parse JSONL files in the project directory and subagents/
  const dirs = [projDirPath, path.join(projDirPath, 'subagents')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, file.name);
      if (mtimeCutoff) {
        try { if (fs.statSync(filePath).mtimeMs < mtimeCutoff) continue; } catch { continue; }
      }
      const { skills, agents, mcpCalls, tokenEntries, promptStats, latencyEntries } = parseTranscriptFile(filePath, cutoffMs);
      allSkills.push(...skills);
      allAgents.push(...agents);
      allMcpCalls.push(...mcpCalls);
      allTokenEntries.push(...tokenEntries);
      allPromptStats.push(...promptStats);
      allLatencyEntries.push(...latencyEntries);
    }

    // Also check session subdirectories (e.g., {sessionId}/subagents/)
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(dir, entry.name);
        let subFiles;
        try { subFiles = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const sf of subFiles) {
          if (!sf.isFile() || !sf.name.endsWith('.jsonl')) continue;
          const fp = path.join(subDir, sf.name);
          if (mtimeCutoff) {
            try { if (fs.statSync(fp).mtimeMs < mtimeCutoff) continue; } catch { continue; }
          }
          const res = parseTranscriptFile(fp, cutoffMs);
          allSkills.push(...res.skills);
          allAgents.push(...res.agents);
          allMcpCalls.push(...res.mcpCalls);
          allTokenEntries.push(...res.tokenEntries);
          allPromptStats.push(...res.promptStats);
          allLatencyEntries.push(...res.latencyEntries);
        }
      }
    } catch { /* skip */ }
  }

  return { skills: allSkills, agents: allAgents, mcpCalls: allMcpCalls, tokenEntries: allTokenEntries, promptStats: allPromptStats, latencyEntries: allLatencyEntries };
}
