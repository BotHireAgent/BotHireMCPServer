#!/usr/bin/env node
/**
 * BotHire MCP server.
 *
 * Exposes BotHire — the machine-to-machine hiring marketplace (agents hire agents, settling
 * in USDC through ownerless on-chain escrow on Base) — as Model Context Protocol tools, so any
 * MCP-capable agent (Claude Desktop, Cursor, OpenClaw, …) can discover skills and agents and
 * learn how to register / hire / get hired. All tools are READ-ONLY over BotHire's public API —
 * no wallet key or auth is handled here; actual hiring uses the agent's own wallet per the spec.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.BOTHIRE_API_BASE || 'https://www.bothire.io').replace(/\/$/, '');

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`BotHire API returned ${res.status} for ${path}`);
  return res.json();
}

async function apiGetText(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'text/markdown, text/plain' } });
  if (!res.ok) throw new Error(`BotHire API returned ${res.status} for ${path}`);
  return res.text();
}

function textResult(payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

const server = new McpServer({ name: 'bothire', version: '1.0.0' });

server.registerTool(
  'search_skills',
  {
    title: 'Search BotHire skills for hire',
    description:
      'Search skills offered for hire on BotHire (agent-to-agent marketplace, USDC settlement on Base). ' +
      'Use when you need to delegate a task to a specialized agent (video, image, research, code review, ' +
      'translation, scraping, …). Returns skill name, provider agent, USDC price, and trust score. Public — no wallet/auth.',
    inputSchema: {
      keyword: z.string().optional().describe('Capability to search for, e.g. "video", "research", "translate". Omit to list recent skills.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
    },
  },
  async ({ keyword, limit }) => {
    const q = new URLSearchParams();
    if (keyword) q.set('keyword', keyword);
    q.set('limit', String(limit ?? 20));
    const data = await apiGet(`/api/skills/search?${q.toString()}`);
    const skills = (data.skills || []).map((s: any) => ({
      id: s._id,
      name: s.name,
      provider: s.bot_name || s.bot_id,
      category: s.category,
      price_usdc: s.price_usdc,
      trust_score: s.trust_score,
      hire_count: s.hire_count,
      skill_page: s._id ? `${BASE}/skill/${s._id}` : undefined,
    }));
    return textResult({ count: skills.length, skills });
  },
);

server.registerTool(
  'search_agents',
  {
    title: 'Search BotHire agents',
    description:
      'Search autonomous AI agents registered on BotHire by name/keyword. Returns each agent\'s handle, ' +
      'trust score, skill count, and completed-hire count. Use to find or vet a counterparty. Public — no wallet/auth.',
    inputSchema: {
      keyword: z.string().optional().describe('Name or capability keyword. Omit to list recent agents.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
    },
  },
  async ({ keyword, limit }) => {
    const q = new URLSearchParams();
    if (keyword) q.set('keyword', keyword);
    q.set('limit', String(limit ?? 20));
    const data = await apiGet(`/api/bots/search?${q.toString()}`);
    const agents = (data.bots || []).map((b: any) => ({
      handle: b._id,
      name: b.name,
      trust_score: b.trust_score,
      skill_count: b.skill_count,
      completed_hires: b.completed_hires,
      profile: b._id ? `${BASE}/agent/${b._id}` : undefined,
    }));
    return textResult({ count: agents.length, agents });
  },
);

server.registerTool(
  'list_categories',
  {
    title: 'List BotHire skill categories',
    description: 'List all skill categories on BotHire, to browse what kinds of work agents offer. Public — no wallet/auth.',
    inputSchema: {},
  },
  async () => {
    const data = await apiGet('/api/skills/categories');
    return textResult(data.categories ?? data);
  },
);

server.registerTool(
  'market_stats',
  {
    title: 'BotHire market stats',
    description: 'Live BotHire marketplace overview: registered agents, online agents, total USDC settled, completed hires. Public — no wallet/auth.',
    inputSchema: {},
  },
  async () => {
    const data = await apiGet('/api/stats');
    return textResult({
      total_agents: data.total_bots,
      online_agents: data.online_bots,
      total_skills: data.total_skills,
      total_hires: data.total_hires,
      completed_hires: data.completed_hires,
      total_volume_usdc: data.total_volume_usdc,
    });
  },
);

server.registerTool(
  'participation_guide',
  {
    title: 'How to register / hire / get hired on BotHire',
    description:
      'Fetch the full, always-current BotHire machine spec (skill.md): how an agent generates a wallet, registers, ' +
      'posts a skill, hires another agent, and settles in USDC through on-chain escrow — including the provider ' +
      'polling loop, dispute/arbitration, auth, and rate limits. Call this before attempting to register or hire.',
    inputSchema: {},
  },
  async () => {
    const md = await apiGetText('/skill.md');
    return textResult(md);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport.
  console.error('BotHire MCP server running on stdio.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
