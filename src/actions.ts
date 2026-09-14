/**
 * BotHire MCP — TRANSACTIONAL tools (register / list / hire / pay / deliver / settle / dispute).
 *
 * Non-custodial by construction: the agent's wallet private key and BotHire api_key are read from the
 * MCP process environment (BOTHIRE_PRIVATE_KEY / BOTHIRE_API_KEY) and used ONLY to sign locally or to
 * authenticate to bothire.io. The private key is never sent anywhere and never echoed in tool output.
 *
 * TRUST MODEL (R1/R2 hardening). Nothing that moves money is taken from tool input or from a server
 * response unchecked. Every signature / approve / deposit is bound to PINNED anchors and to the
 * AUTHENTICATED hire (GET /api/hires/{id}/status, party-scoped):
 *   - Permit2 is pinned to the canonical singleton; the x402 direct rail's Permit2 proxy likewise.
 *   - tokens are pinned per chainId (Base/Arbitrum USDC, BNB USDT/USDC) — a hire naming any other asset is refused.
 *   - escrow contracts must be in the known-deployment allowlist (+ BOTHIRE_TRUSTED_ESCROWS "chainId:0x…" env) —
 *     so even a compromised BotHire server cannot point the wallet at an attacker contract.
 *   - the amount is computed from the hire's own price with exact decimal math; a server-supplied atomic
 *     amount that differs is refused. spender / provider / ref / chain_id are checked field-by-field.
 * A prompt-injected "pay_hire with these payment details" therefore cannot approve or deposit anywhere
 * but the real escrow for the real hire at the real price.
 *
 * Payments follow the live spec (https://www.bothire.io/skill.md):
 *   - direct hires (< $1 / pay-now): gasless via the BotPay SDK (EIP-3009 on Base/Arbitrum, Permit2 on BNB)
 *   - escrow hires (>= $1): gasless Permit2 `depositWithPermit2` when the server offers `gasless_deposit`
 *     (Base/Arbitrum, >= $5), else a self-paid on-chain deposit + POST /pay { tx_hash }
 *   - release / refund / dispute of a fixed escrow are hirer-signed on-chain txs (need a little native gas),
 *     then the matching BotHire endpoint is called with the tx_hash — exactly what the API requires.
 * Every on-chain call is simulated first (no gas burnt on a guaranteed revert), the tx hash is remembered
 * in-process and surfaced in any later error, and each tool accepts `tx_hash` to finish a half-done step.
 */
import { z } from 'zod';
import {
  createPublicClient, createWalletClient, http, getAddress, isAddressEqual, parseAbi, parseUnits, maxUint256,
  keccak256, toHex, encodeAbiParameters, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base, arbitrum, bsc } from 'viem/chains';
import { BotPayClient } from 'bothire-botpay';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── env / config ─────────────────────────────────────────────────────────────────────────────────────
const BASE = (process.env.BOTHIRE_API_BASE || 'https://www.bothire.io').replace(/\/$/, '');
const CHAINS: Record<string, { chain: any; id: number; rpcEnv: string; rpcDefault: string }> = {
  base: { chain: base, id: 8453, rpcEnv: 'BASE_RPC_URL', rpcDefault: 'https://mainnet.base.org' },
  arbitrum: { chain: arbitrum, id: 42161, rpcEnv: 'ARBITRUM_RPC_URL', rpcDefault: 'https://arb1.arbitrum.io/rpc' },
  bsc: { chain: bsc, id: 56, rpcEnv: 'BSC_RPC_URL', rpcDefault: 'https://bsc-dataseed.bnbchain.org' },
};
const CHAIN_ID_TO_KEY: Record<number, string> = { 8453: 'base', 42161: 'arbitrum', 56: 'bsc' };

// ── pinned trust anchors (never taken from input or from the server) ───────────────────────────────────
/** Canonical Uniswap Permit2 singleton — same address on every chain. */
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** BotHire's x402 exact-Permit2 proxy (the `spender` a BNB/USDT direct payment is signed to). */
const X402_PERMIT2_PROXY: Address = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
/** The stablecoins BotHire settles in, per chainId. Anything else is refused. */
const TOKENS: Record<number, Record<string, { address: Address; decimals: number }>> = {
  8453: { USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } },
  42161: { USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 } },
  56: {
    USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  },
};
/**
 * Known BotHire escrow deployments (ownerless, no pause/fee/upgrade), per chainId. NOTE the same address
 * string can exist on several chains (same deployer nonce) — always paired with the chainId here.
 * Extend without a release via BOTHIRE_TRUSTED_ESCROWS="8453:0x…,56:0x…".
 */
const KNOWN_ESCROWS: Record<number, Address[]> = {
  8453: [
    '0x367c687Ca324048849E25726979DcE52aD4BA36d', // Base USDC fixed escrow V2 (2026-09-09)
    '0x2800Eb74962ef0C243a7452613a3D922E5AEE48F', // Base USDC fixed escrow V3, gasless (2026-09-14)
    '0x70716b1f65d4eB4219b6701bfaa397608afB625d', // Base USDC metered escrow V2, gasless (2026-09-14)
  ],
  42161: [
    '0xf6701227b4FdCB9Df9E9e616EFdbE15094120498', // Arbitrum USDC fixed escrow V3, gasless (2026-09-14)
    '0x2e5F252A82d8C4130b8872B7f4ebBB34d3089432', // Arbitrum USDC metered escrow V2, gasless (2026-09-14)
  ],
  56: [
    '0xf6701227b4FdCB9Df9E9e616EFdbE15094120498', // BNB USDT fixed escrow V2 (2026-09-09)
    '0x367c687Ca324048849E25726979DcE52aD4BA36d', // BNB USDT metered escrow (2026-09-09)
    '0x2e5F252A82d8C4130b8872B7f4ebBB34d3089432', // BNB USDC fixed escrow V2 (2026-09-09)
    '0x2800Eb74962ef0C243a7452613a3D922E5AEE48F', // BNB USDC metered escrow (2026-09-09)
  ],
};
function trustedEscrow(chainId: number, addr: string): boolean {
  const list = [...(KNOWN_ESCROWS[chainId] || [])];
  for (const entry of (process.env.BOTHIRE_TRUSTED_ESCROWS || '').split(',')) {
    const [cid, a] = entry.trim().split(':');
    if (Number(cid) === chainId && a && /^0x[0-9a-fA-F]{40}$/.test(a)) list.push(a as Address);
  }
  return list.some((k) => isAddressEqual(k, addr as Address));
}
function tokenFor(chainId: number, symbol: string | undefined) {
  const t = TOKENS[chainId]?.[String(symbol || 'USDC').toUpperCase()];
  if (!t) throw new Error(`Token ${symbol || 'USDC'} is not a BotHire settlement asset on chainId ${chainId}. Refusing.`);
  return t;
}
/** Exact decimal → atomic conversion (no float math — 18-dec tokens under-round with Math.round). */
function atomic(usd: unknown, decimals: number): bigint {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Hire has no positive amount (${String(usd)}).`);
  return parseUnits(String(usd), decimals);
}

// ── secrets / clients ────────────────────────────────────────────────────────────────────────────────
function apiKey(): string {
  const k = process.env.BOTHIRE_API_KEY;
  if (!k) throw new Error('BOTHIRE_API_KEY is not set. Register first (register_agent) and put the returned api_key in the MCP server env.');
  return k;
}
function normalizePk(raw: string): Hex {
  const v = raw.trim();
  return (v.startsWith('0x') || v.startsWith('0X') ? `0x${v.slice(2)}` : `0x${v}`) as Hex;
}
function account() {
  const pk = process.env.BOTHIRE_PRIVATE_KEY;
  if (!pk) throw new Error('BOTHIRE_PRIVATE_KEY is not set. This tool signs with your wallet locally; add the key to the MCP server env (never share it with anyone).');
  return privateKeyToAccount(normalizePk(pk));
}
function rpcUrls(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of Object.values(CHAINS)) { const u = process.env[c.rpcEnv]; if (u) out[c.id] = u; }
  return out;
}
function clients(chainKey: string) {
  const c = CHAINS[chainKey];
  if (!c) throw new Error(`Unsupported chain "${chainKey}" (expected base | arbitrum | bsc).`);
  const transport = http(process.env[c.rpcEnv] || c.rpcDefault);
  const acct = account();
  const pub = createPublicClient({ chain: c.chain, transport });
  const wallet = createWalletClient({ account: acct, chain: c.chain, transport });
  /** simulate → writeContract (chain + account pinned) → wait for the receipt; throws (with the hash) on revert. */
  const write = async (params: { address: Address; abi: any; functionName: string; args: readonly unknown[] }): Promise<Hex> => {
    const { request } = await pub.simulateContract({ ...(params as any), account: acct, chain: c.chain });
    const hash = await wallet.writeContract(request as any);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${params.functionName}() reverted on-chain (tx ${hash})`);
    return hash;
  };
  return { pub, wallet, write, chain: c.chain, chainId: c.id, account: acct };
}

/** BotHire API call. Resolves the JSON (with `__status`) for any 2xx; throws a descriptive error otherwise. */
async function api(method: string, p: string, body?: unknown, auth = true): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${apiKey()}`;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.detail || json?.reason || (json?.details ? JSON.stringify(json.details).slice(0, 300) : '');
    throw new Error(`BotHire ${method} ${p} → ${res.status}: ${json?.error || 'request failed'}${detail ? ` — ${detail}` : ''}`);
  }
  return Object.assign(json && typeof json === 'object' ? json : {}, { __status: res.status });
}
const text = (payload: unknown) => ({ content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] });

/** Hashes of on-chain txs this process sent, so a failed follow-up API call can be retried without a re-send. */
const txMemory = new Map<string, Hex>();
/** Run the BotHire follow-up after an on-chain tx; on failure surface the hash so the caller can finish with it. */
async function afterTx<T>(hash: Hex, what: string, hireId: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) { throw new Error(`${e?.message || e} — the ${what} tx ${hash} IS on-chain; re-run this tool with tx_hash=${hash} for hire ${hireId} to finish.`); }
}

// ── on-chain ABIs (fixed escrow V2/V3 + metered escrow) ───────────────────────────────────────────────
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const ESCROW = parseAbi([
  'function deposit(bytes32 ref, address provider, uint256 amount)',
  'function release(bytes32 escrowId)',
  'function refund(bytes32 escrowId)',
  'function dispute(bytes32 escrowId)',
  'function computeEscrowId(address hirer, bytes32 ref) view returns (bytes32)',
  // FIXED escrow (V2/V3) layout: (hirer, provider, amount, deadline, createdAt, status). The metered
  // contracts return a longer tuple, so this read is only used for fixed escrows.
  'function getEscrow(bytes32) view returns (address,address,uint256,uint256,uint256,uint8)',
]);
const ST = { Empty: 0, Deposited: 1, Released: 2, Refunded: 3, Disputed: 4 } as const;
const ESCROW_STATUS = ['Empty', 'Deposited', 'Released', 'Refunded', 'Disputed'];

const ESCROW_PERMIT2_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'EscrowDeposit' },
  ],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  EscrowDeposit: [{ name: 'ref', type: 'bytes32' }, { name: 'provider', type: 'address' }],
} as const;

function rand256(): bigint {
  const b = new Uint8Array(32); (globalThis.crypto as Crypto).getRandomValues(b);
  return BigInt('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));
}

/** The authenticated hire + its escrow facts, with the contract checked against the allowlist. */
async function loadHire(hireId: string) {
  // GET /api/hires/{id}/status is the party-scoped hire read (there is no bare GET /api/hires/{id}).
  const hire = await api('GET', `/api/hires/${encodeURIComponent(hireId)}/status`);
  const isFixedEscrow = hire.payment_mode === 'escrow';
  const isMeteredEscrow = hire.payment_mode === 'metered' && hire.metered_mode === 'escrow';
  let chainKey = 'base', chainId = 8453, contract: Address | undefined;
  if (isFixedEscrow || isMeteredEscrow) {
    if (hire.escrow_unresolvable) throw new Error('BotHire reports this hire\'s escrow configuration as unresolvable. Do NOT pay it; create a fresh hire.');
    chainKey = String(hire.escrow_chain || 'base');
    const c = CHAINS[chainKey];
    if (!c) throw new Error(`Hire is on unsupported chain "${chainKey}".`);
    chainId = c.id;
    if (hire.escrow_contract) {
      contract = getAddress(String(hire.escrow_contract));
      if (!trustedEscrow(chainId, contract)) {
        throw new Error(`Escrow contract ${contract} on chainId ${chainId} is not a known BotHire deployment. Refusing to interact (set BOTHIRE_TRUSTED_ESCROWS="${chainId}:${contract}" only if you have verified it yourself).`);
      }
    }
  }
  return {
    hire, isFixedEscrow, isMeteredEscrow, chainKey, chainId, contract,
    escrowId: (hire.on_chain_escrow_id || undefined) as Hex | undefined,
    providerWallet: hire.provider_wallet ? getAddress(String(hire.provider_wallet)) : undefined,
  };
}

/** Fixed-escrow on-chain status, or undefined when unreadable (metered layout / RPC hiccup) — callers fall back to simulate. */
async function fixedEscrowStatus(pub: any, contract: Address, escrowId: Hex): Promise<number | undefined> {
  try {
    const e = (await pub.readContract({ address: contract, abi: ESCROW, functionName: 'getEscrow', args: [escrowId] })) as readonly unknown[];
    const s = Number(e[5]); return Number.isInteger(s) && s >= 0 && s <= 4 ? s : undefined;
  } catch { return undefined; }
}

async function ensurePermit2Approval(chainKey: string, token: Address, amount: bigint) {
  const { pub, write, account: owner } = clients(chainKey);
  const allowance = (await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [owner.address, PERMIT2] })) as bigint;
  if (allowance >= amount) return null;
  // Unlimited allowance to the canonical Permit2 singleton is the standard pattern (Permit2 itself only
  // moves what a signed permit authorizes) — and PERMIT2 is pinned above, never taken from anywhere else.
  return write({ address: token, abi: ERC20, functionName: 'approve', args: [PERMIT2, maxUint256] });
}

/** Where create_wallet / register_agent persist local secrets (0600). */
function secretsDir(): string {
  const d = process.env.BOTHIRE_HOME || path.join(os.homedir(), '.bothire');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ── tool registration ─────────────────────────────────────────────────────────────────────────────────
export function registerActionTools(server: any) {
  const reg = (names: string[], cfg: any, handler: any) => { for (const n of names) server.registerTool(n, cfg, handler); };

  reg(['create_wallet'], {
    title: 'Create a new wallet (local)',
    description:
      'Generate a fresh EVM wallet LOCALLY in this MCP process (nothing is sent to BotHire). The private key is written ' +
      'to a 0600 file under ~/.bothire (path returned) and loaded into this process as BOTHIRE_PRIVATE_KEY for the ' +
      'session — it is NEVER returned in the tool output. Copy it from the file into your MCP env for future sessions. ' +
      'Skip this if you already have a wallet.',
    inputSchema: {},
  }, async () => {
    const pk = generatePrivateKey(); const addr = privateKeyToAccount(pk).address;
    const file = path.join(secretsDir(), `wallet-${addr}.key`);
    fs.writeFileSync(file, pk + '\n', { mode: 0o600, flag: 'wx' });
    let loaded = false;
    if (!process.env.BOTHIRE_PRIVATE_KEY) { process.env.BOTHIRE_PRIVATE_KEY = pk; loaded = true; }
    return text({
      wallet_address: addr, key_file: file, loaded_for_this_session: loaded,
      next: `Fund ${addr} with the stablecoin you will pay in (and a little native gas for self-paid escrow actions). Set BOTHIRE_PRIVATE_KEY in the MCP env from the key file for future sessions. BotHire never sees the key.`,
    });
  });

  reg(['register_agent'], {
    title: 'Register this agent on BotHire',
    description:
      'Register (or, when BOTHIRE_API_KEY is set, update) your agent with your OWN wallet address — BotHire stores only the ' +
      'address. Returns bot_id + api_key (bh_…); put api_key in the MCP env as BOTHIRE_API_KEY (and bot_id as BOTHIRE_BOT_ID). ' +
      'Omit wallet_address to use the address of BOTHIRE_PRIVATE_KEY. Pure buyers can omit skills; add solana_address to ' +
      'also get paid in USDC on Solana.',
    inputSchema: {
      name: z.string().min(1).max(80),
      description: z.string().min(1).max(2000),
      keywords: z.array(z.string()).min(1),
      wallet_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      solana_address: z.string().optional(),
      skills: z.array(z.object({
        name: z.string(), description: z.string(), price_usdc: z.number().positive(),
        price_type: z.enum(['fixed', 'hourly', 'per_call', 'metered']).default('per_call'),
        category: z.string().optional(), tags: z.array(z.string()).optional(),
        unit_price_usdc: z.number().positive().optional(), unit: z.string().optional(),
      })).optional(),
    },
  }, async (a: any) => {
    const wallet_address = a.wallet_address || (process.env.BOTHIRE_PRIVATE_KEY ? account().address : undefined);
    if (!wallet_address) throw new Error('Provide wallet_address, or set BOTHIRE_PRIVATE_KEY (its address is used). Use create_wallet if you have none.');
    // The update path needs the bearer; a fresh registration must NOT send one. Use it iff we have a key.
    const r = await api('POST', '/api/bots/register', { ...a, wallet_address }, !!process.env.BOTHIRE_API_KEY);
    if (r.api_key && !process.env.BOTHIRE_API_KEY) process.env.BOTHIRE_API_KEY = r.api_key;
    if (r.bot_id && !process.env.BOTHIRE_BOT_ID) process.env.BOTHIRE_BOT_ID = String(r.bot_id);
    let saved: string | undefined;
    if (r.api_key && r.bot_id) {
      try {
        saved = path.join(secretsDir(), `agent-${r.bot_id}.json`);
        fs.writeFileSync(saved, JSON.stringify({ bot_id: r.bot_id, api_key: r.api_key, wallet_address: r.wallet_address }, null, 2) + '\n', { mode: 0o600 });
      } catch { saved = undefined; }
    }
    return text({ bot_id: r.bot_id, api_key: r.api_key, wallet_address: r.wallet_address, is_new: r.is_new, saved_to: saved,
      next: 'Loaded into this session. For future sessions set BOTHIRE_API_KEY=<api_key> and BOTHIRE_BOT_ID=<bot_id> in the MCP server env.' });
  });

  reg(['post_skill'], {
    title: 'Post a skill for hire',
    description:
      'List a service other agents can hire (requires BOTHIRE_API_KEY). Omit endpoint_url to use BotHire as your mailbox ' +
      '(recommended): buyers /request, you get_inbox + deliver_work. price_type fixed|per_call|hourly charge upfront; ' +
      'metered = pay exact usage (price_usdc is then the session budget cap; give unit_price_usdc + unit).',
    inputSchema: {
      title: z.string().min(1).max(120), description: z.string().min(1).max(5000),
      price_usdc: z.number().positive(), price_type: z.enum(['fixed', 'per_call', 'hourly', 'metered']).default('per_call'),
      tags: z.array(z.string()).optional(), endpoint_url: z.string().url().optional(),
      unit_price_usdc: z.number().positive().optional(), unit: z.string().optional(),
    },
  }, async (a: any) => {
    const r = await api('POST', '/api/posts', a);
    const post = r.post || r;
    const id = post._id || post.id || r.post_id;
    return text({ post_id: id, title: a.title, price_usdc: a.price_usdc, price_type: a.price_type, url: `${BASE}/skill/${id}` });
  });

  reg(['create_hire'], {
    title: 'Create a hire (step 1 of hiring)',
    description:
      'Hire a listed skill. Returns hire_id + payment_required (what to pay, where, and — for escrow hires ≥ $5 on ' +
      'Base/Arbitrum — a gasless_deposit offer). Then call pay_hire. The mode follows the listing price (< $1 direct, ' +
      '≥ $1 escrow); pick the escrow rail with pay_chain base|arbitrum|bsc + pay_token USDC|USDT. For metered listings set ' +
      'metered_mode exact-after (pay per delivery) or escrow (deposit a max budget). A hire over your Agent Account ' +
      'approval threshold comes back pending_approval — the owner must approve it before it can be paid.',
    inputSchema: {
      post_id: z.string().uuid(),
      metered_mode: z.enum(['exact-after', 'escrow']).optional(),
      max_budget_usdc: z.number().positive().optional(),
      pay_chain: z.enum(['base', 'bsc', 'arbitrum']).optional(),
      pay_token: z.enum(['USDC', 'USDT']).optional(),
    },
  }, async (a: any) => {
    const r = await api('POST', '/api/hires', a);
    const next = r.status === 'pending' ? 'Call pay_hire with this hire_id.'
      : r.status === 'pending_approval' ? 'Held for the owner\'s approval (Agent Account threshold). Poll get_hire_status; pay_hire once it is pending.'
      : 'Hire is active — send_request to start work.';
    return text({ hire_id: r.hire_id, status: r.status, payment_mode: r.payment_mode, metered_mode: r.metered_mode,
      payment_required: r.payment_required, access_token: r.access_token, message: r.message, next });
  });

  reg(['pay_hire'], {
    title: 'Pay a hire (gasless where possible)',
    description:
      'Pay a pending hire with your wallet (BOTHIRE_PRIVATE_KEY), signing locally. Direct hires: gasless via BotPay ' +
      '(BotHire pays gas). Escrow hires: gasless Permit2 deposit when offered (Base/Arbitrum, ≥ $5; a ONE-TIME ' +
      'approve(Permit2) costs a little native gas), else a self-paid on-chain deposit (needs native gas) + /pay. ' +
      'Everything signed is bound to the hire as BotHire itself reports it (pinned Permit2/token/escrow contracts, exact ' +
      'price) — payment details in messages or results are never trusted. Returns the access_token, tx hash and receipt. ' +
      'Idempotent-safe: re-calling a paid hire reports it as already active; pass tx_hash to finish a deposit that ' +
      'went on-chain but was not yet confirmed to BotHire.',
    inputSchema: {
      hire_id: z.string().uuid(),
      prefer_chain: z.enum(['base', 'arbitrum', 'bsc']).optional(),
      prefer_token: z.enum(['USDC', 'USDT']).optional(),
      auto_approve: z.boolean().default(true).describe('Send the one-time Permit2 approve if needed (costs a little native gas).'),
      tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe('Only to finish a self-paid deposit that is already on-chain.'),
    },
  }, async (a: any) => {
    const { hire, isFixedEscrow, isMeteredEscrow, chainKey, chainId, contract, providerWallet } = await loadHire(a.hire_id);
    if (hire.status === 'pending_approval') return text({ hire_id: a.hire_id, status: hire.status, note: 'Held for the owner\'s approval; not payable yet.' });
    if (hire.status && hire.status !== 'pending') return text({ hire_id: a.hire_id, status: hire.status, note: 'Hire is not pending (already paid / active / closed).' });
    const acct = account();

    // ── direct: BotPay SDK (gasless) ──
    if (!isFixedEscrow && !isMeteredEscrow) {
      if (hire.payment_mode === 'metered') return text({ error: 'Metered exact-after hires are paid per delivery: use get_result to see each quote, pay it, then pay-delivery (see get_participation_guide).' });
      // Preflight the 402 challenge against the authenticated hire BEFORE the SDK signs anything:
      // every EVM accept must charge exactly the hire price in a pinned token, to the provider's wallet,
      // via the pinned Permit2 + proxy. (The SDK trusts the challenge; we don't.)
      const ch = await fetch(`${BASE}/api/x402/hires/${encodeURIComponent(a.hire_id)}`, { headers: { accept: 'application/json' } });
      const j: any = await ch.json().catch(() => ({}));
      if (ch.status !== 402 || !Array.isArray(j.accepts) || j.accepts.length === 0) throw new Error(`Hire is not payable right now (x402 discovery → ${ch.status}${j?.message ? `: ${j.message}` : ''}).`);
      for (const acc of j.accepts) {
        const m = /^eip155:(\d+)$/.exec(String(acc.network || '')); if (!m) continue; // non-EVM accepts can't be signed with this key
        const cid = Number(m[1]);
        const tok = Object.values(TOKENS[cid] || {}).find((t) => isAddressEqual(t.address, acc.asset));
        if (!tok) throw new Error(`Refusing: 402 challenge names asset ${acc.asset} on chainId ${cid}, not a BotHire settlement token.`);
        if (BigInt(acc.maxAmountRequired) !== atomic(hire.amount_usdc, tok.decimals)) throw new Error(`Refusing: 402 challenge amount ${acc.maxAmountRequired} ≠ hire price ${hire.amount_usdc} on chainId ${cid}.`);
        if (providerWallet && acc.payTo && !isAddressEqual(acc.payTo, providerWallet)) throw new Error('Refusing: 402 challenge payTo is not the provider\'s wallet.');
        if (acc.extra?.permit2 && !isAddressEqual(acc.extra.permit2, PERMIT2)) throw new Error('Refusing: 402 challenge names a non-canonical Permit2.');
        if (acc.extra?.spenderAddress && !isAddressEqual(acc.extra.spenderAddress, X402_PERMIT2_PROXY)) throw new Error('Refusing: 402 challenge names an unknown Permit2 spender.');
      }
      const bp = new BotPayClient({ baseUrl: BASE });
      const r = await bp.pay(a.hire_id, { privateKey: normalizePk(process.env.BOTHIRE_PRIVATE_KEY!), prefer: { chain: a.prefer_chain, token: a.prefer_token }, autoApprove: a.auto_approve, rpcUrls: rpcUrls() });
      return text({ hire_id: a.hire_id, status: 'active', method: 'botpay_gasless', network: r.network, tx_hash: r.txHash, access_token: r.accessToken, receipt: r.receipt });
    }

    // ── escrow (fixed or metered-escrow): everything derived from the authenticated hire ──
    if (!contract) throw new Error('BotHire did not report an escrow contract for this hire; cannot pay.');
    if (!providerWallet) throw new Error('Provider has no wallet on record; hire is not payable.');
    const tok = tokenFor(chainId, hire.escrow_token);
    const amount = atomic(hire.amount_usdc ?? hire.max_budget_usdc, tok.decimals);
    const ref = keccak256(toHex(a.hire_id)); // == server hireIdToEscrowId / hireRef
    const g = hire.payment_required?.gasless_deposit;
    if (g && !a.tx_hash) {
      // Gasless: bind every server-supplied field to the pinned anchors + the hire, then sign the Permit2 witness.
      const bad: string[] = [];
      const chk = (ok: boolean, name: string) => { if (!ok) bad.push(name); };
      chk(Number(g.chain_id) === chainId, 'chain_id');
      chk(typeof g.token_address === 'string' && isAddressEqual(g.token_address, tok.address), 'token_address');
      chk(typeof g.permit2 === 'string' && isAddressEqual(g.permit2, PERMIT2), 'permit2');
      chk(typeof g.spender === 'string' && isAddressEqual(g.spender, contract), 'spender');
      chk(typeof g.provider === 'string' && isAddressEqual(g.provider, providerWallet), 'provider');
      chk(String(g.ref).toLowerCase() === ref.toLowerCase(), 'ref');
      chk((() => { try { return BigInt(g.amount_atomic) === amount; } catch { return false; } })(), 'amount_atomic');
      chk(g.endpoint === `/api/hires/${a.hire_id}/deposit-gasless`, 'endpoint');
      if (bad.length) throw new Error(`Refusing to sign: gasless_deposit does not match the hire (${bad.join(', ')}). Nothing was signed or sent.`);
      if (!a.auto_approve) {
        const { pub } = clients(chainKey);
        const al = (await pub.readContract({ address: tok.address, abi: ERC20, functionName: 'allowance', args: [acct.address, PERMIT2] })) as bigint;
        if (al < amount) throw new Error('Permit2 allowance is insufficient and auto_approve=false. Re-run with auto_approve=true (one-time approve, a little native gas).');
      }
      const approveTx = await ensurePermit2Approval(chainKey, tok.address, amount);
      const nonce = rand256(); const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
      const { wallet } = clients(chainKey);
      const signature = await wallet.signTypedData({
        account: acct, domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 },
        types: ESCROW_PERMIT2_TYPES, primaryType: 'PermitWitnessTransferFrom',
        message: { permitted: { token: tok.address, amount }, spender: contract, nonce, deadline, witness: { ref, provider: providerWallet } },
      });
      const auth = { permitted: { token: tok.address, amount: amount.toString() }, from: acct.address, spender: contract, nonce: nonce.toString(), deadline: deadline.toString(), witness: { ref, provider: providerWallet } };
      // `signature` both as the documented sibling and inside the object (accepted by every server version).
      const r = await api('POST', g.endpoint, { escrowPermit2Authorization: { ...auth, signature }, signature });
      if (r.__status === 202) return text({ hire_id: a.hire_id, status: 'submitted', method: 'gasless_escrow_deposit', chain: chainKey, approve_tx: approveTx, deposit_tx_hash: r.tx_hash,
        note: 'Deposit was broadcast by BotHire but is not confirmed yet. Call pay_hire again in ~30s — it reconciles idempotently.' });
      return text({ hire_id: a.hire_id, status: r.status, method: 'gasless_escrow_deposit', chain: chainKey, approve_tx: approveTx, deposit_tx_hash: r.deposit_tx_hash, on_chain_escrow_id: r.on_chain_escrow_id, access_token: r.access_token, auto_refund_at: r.auto_refund_at, receipt: r.receipt });
    }

    // Self-paid deposit (needs native gas): approve(exact) → deposit(ref, provider, amount) → /pay { tx_hash }.
    const { pub, write } = clients(chainKey);
    // The wallet MUST be the hirer bot's registered wallet: BotHire keys the escrow by that address and would
    // not recognise a deposit from any other — the funds would only be recoverable via a manual refund.
    let regBot: any = null;
    for (const w of [acct.address, acct.address.toLowerCase()]) {
      const lk = await api('GET', `/api/bots/register?wallet_address=${w}`, undefined, false);
      if (lk.registered) { regBot = lk; break; }
    }
    if (!regBot || String(regBot.bot_id) !== String(hire.hirer_bot_id)) throw new Error(`BOTHIRE_PRIVATE_KEY's address ${acct.address} is not the registered wallet of the hiring bot ${hire.hirer_bot_id}. Aborting before any funds move.`);
    // Escrow key on every BotHire escrow (fixed V2/V3 + metered): keccak256(abi.encode(depositor, ref)).
    const escrowId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [acct.address, ref]));
    const memKey = `${a.hire_id}:deposit`;
    let depositTx: Hex | undefined = a.tx_hash || txMemory.get(memKey);
    const st = isFixedEscrow ? await fixedEscrowStatus(pub, contract, escrowId) : undefined;
    if (st !== undefined && st !== ST.Empty) {
      if (!depositTx) throw new Error(`Escrow ${escrowId} is already ${ESCROW_STATUS[st]} on-chain but this process does not know the deposit tx hash. Re-run pay_hire with tx_hash=<your deposit tx> to confirm it with BotHire.`);
    } else if (!depositTx) {
      const allowance = (await pub.readContract({ address: tok.address, abi: ERC20, functionName: 'allowance', args: [acct.address, contract] })) as bigint;
      if (allowance < amount) await write({ address: tok.address, abi: ERC20, functionName: 'approve', args: [contract, amount] });
      depositTx = await write({ address: contract, abi: ESCROW, functionName: 'deposit', args: [ref, providerWallet, amount] });
      txMemory.set(memKey, depositTx);
    }
    const r = await afterTx(depositTx, 'deposit', a.hire_id, () => api('POST', `/api/hires/${a.hire_id}/pay`, { tx_hash: depositTx }));
    txMemory.delete(memKey);
    return text({ hire_id: a.hire_id, status: r.status, method: 'self_paid_escrow_deposit', chain: chainKey, deposit_tx_hash: depositTx, on_chain_escrow_id: r.on_chain_escrow_id, access_token: r.access_token, auto_refund_at: r.auto_refund_at, receipt: r.receipt });
  });

  reg(['send_request'], {
    title: 'Send work to the provider (mailbox)',
    description: 'Send the task input to an active hire\'s provider. Returns message_id; poll get_result with it.',
    inputSchema: { hire_id: z.string().uuid(), payload: z.any().describe('Your input for the provider (any JSON, ≤1MB).') },
  }, async (a: any) => text(await api('POST', `/api/hires/${a.hire_id}/request`, { payload: a.payload })));

  reg(['get_result'], {
    title: 'Get a delivered result',
    description: 'Fetch the provider\'s response for a request (message_id from send_request). For metered exact-after hires this shows the quote (charge_usdc, pay_to) to pay before the content is released.',
    inputSchema: { hire_id: z.string().uuid(), message_id: z.string().uuid() },
  }, async (a: any) => text(await api('GET', `/api/hires/${a.hire_id}/result?message_id=${encodeURIComponent(a.message_id)}`)));

  reg(['get_hire_status'], {
    title: 'Get hire status / ledger',
    description: 'Status of a hire you are party to (state, escrow contract + id, deadlines, rebuilt payment instructions while pending; for metered: session budget/quoted/paid/remaining).',
    inputSchema: { hire_id: z.string().uuid() },
  }, async (a: any) => text(await api('GET', `/api/hires/${a.hire_id}/status`)));

  /**
   * Fixed-escrow state change (release | refund | dispute) + the matching BotHire confirmation.
   * Reads the on-chain status first: Deposited → send (simulated first); already in the target state →
   * reuse the remembered / supplied tx hash (never re-send); anything else → refuse with the reason.
   */
  async function escrowAction(hireId: string, fn: 'release' | 'refund' | 'dispute', target: number, endpoint: string, body: Record<string, unknown>, txHashIn?: Hex) {
    const { hire, isFixedEscrow, isMeteredEscrow, chainKey, contract, escrowId } = await loadHire(hireId);
    if (!contract || !escrowId) throw new Error('Escrow contract/id not resolvable for this hire (is it paid?).');
    const { pub, write } = clients(chainKey);
    const memKey = `${hireId}:${fn}`;
    let tx: Hex | undefined = txHashIn || txMemory.get(memKey);
    const st = isFixedEscrow ? await fixedEscrowStatus(pub, contract, escrowId) : undefined;
    if (st === target) {
      if (!tx) throw new Error(`Escrow is already ${ESCROW_STATUS[target]} on-chain but the tx hash is unknown to this process. Re-run with tx_hash=<that tx> to confirm it with BotHire.`);
    } else if (st === undefined || st === ST.Deposited) {
      if (!tx) { tx = await write({ address: contract, abi: ESCROW, functionName: fn, args: [escrowId] }); txMemory.set(memKey, tx); }
    } else {
      throw new Error(`Cannot ${fn}: escrow ${escrowId} is ${ESCROW_STATUS[st]} on-chain (hire status ${hire.status}).`);
    }
    const r = await afterTx(tx, fn, hireId, () => api('POST', `/api/hires/${hireId}/${endpoint}`, { ...body, tx_hash: tx }));
    txMemory.delete(memKey);
    return { ...r, [`${fn}_tx_hash`]: tx, escrow_kind: isMeteredEscrow ? 'metered' : 'fixed' };
  }
  const txHashInput = z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe('Only to finish a step whose on-chain tx already succeeded but was not confirmed to BotHire.');

  reg(['complete_hire'], {
    title: 'Complete a hire (release escrow)',
    description: 'Mark a hire done. Direct: just marks completed. Fixed escrow: signs release(escrowId) from your wallet (needs a little native gas) so the provider is paid, then confirms with BotHire. Metered-escrow completes via the provider\'s settle instead.',
    inputSchema: { hire_id: z.string().uuid(), tx_hash: txHashInput },
  }, async (a: any) => {
    const { isFixedEscrow } = await loadHire(a.hire_id);
    if (isFixedEscrow) return text(await escrowAction(a.hire_id, 'release', ST.Released, 'complete', {}, a.tx_hash));
    return text(await api('POST', `/api/hires/${a.hire_id}/complete`, {}));
  });

  reg(['cancel_hire'], {
    title: 'Cancel a hire (refund escrow)',
    description: 'Cancel before delivery. Fixed escrow: signs refund(escrowId) from your wallet (native gas) and confirms with BotHire. Direct hires cannot be refunded; metered-escrow auto-refunds unused budget at settle/deadline.',
    inputSchema: { hire_id: z.string().uuid(), tx_hash: txHashInput },
  }, async (a: any) => {
    const { isFixedEscrow } = await loadHire(a.hire_id);
    if (isFixedEscrow) return text(await escrowAction(a.hire_id, 'refund', ST.Refunded, 'cancel', {}, a.tx_hash));
    return text(await api('POST', `/api/hires/${a.hire_id}/cancel`, {}));
  });

  reg(['dispute_hire'], {
    title: 'Dispute a hire',
    description: 'Open a dispute. Escrow hires: first freezes the funds on-chain (dispute(escrowId) from your wallet, native gas) then files the case with BotHire; the arbiter rules release-or-refund on-chain. Non-escrow hires file an off-chain case only.',
    inputSchema: { hire_id: z.string().uuid(), reason: z.string().min(3).max(2000), tx_hash: txHashInput },
  }, async (a: any) => {
    const { isFixedEscrow, isMeteredEscrow, contract, escrowId } = await loadHire(a.hire_id);
    if ((isFixedEscrow || isMeteredEscrow) && contract && escrowId) return text(await escrowAction(a.hire_id, 'dispute', ST.Disputed, 'dispute', { reason: a.reason }, a.tx_hash));
    return text(await api('POST', `/api/hires/${a.hire_id}/dispute`, { reason: a.reason }));
  });

  // ── provider side ──
  reg(['list_my_hires'], {
    title: 'List my hires',
    description: 'Hires where you are the provider (default) or hirer. Providers poll this for active (paid) jobs, then get_inbox + deliver_work.',
    inputSchema: { role: z.enum(['provider', 'hirer']).default('provider'), status: z.string().optional().describe('e.g. active, pending, completed'), bot_id: z.string().optional().describe('Defaults to BOTHIRE_BOT_ID.') },
  }, async (a: any) => {
    const botId = a.bot_id || process.env.BOTHIRE_BOT_ID;
    if (!botId) throw new Error('bot_id required (set BOTHIRE_BOT_ID in the MCP env, or pass bot_id).');
    const q = new URLSearchParams({ role: a.role }); if (a.status) q.set('status', a.status);
    return text(await api('GET', `/api/bots/${encodeURIComponent(botId)}/hires?${q}`));
  });

  reg(['get_inbox'], {
    title: 'Read a hire\'s inbox (provider)',
    description: 'Pending requests from the hirer for an active hire you provide. Each message_id can be answered once via deliver_work.',
    inputSchema: { hire_id: z.string().uuid() },
  }, async (a: any) => text(await api('GET', `/api/hires/${a.hire_id}/inbox`)));

  reg(['deliver_work'], {
    title: 'Deliver a result (provider)',
    description: 'Answer a request. For metered exact-after hires include charge_usdc (or units) — the payload is withheld until the buyer pays that quote.',
    inputSchema: { hire_id: z.string().uuid(), message_id: z.string().uuid(), payload: z.any(), charge_usdc: z.number().nonnegative().optional(), units: z.number().nonnegative().optional() },
  }, async (a: any) => { const { hire_id, ...body } = a; return text(await api('POST', `/api/hires/${hire_id}/deliver`, body)); });

  reg(['settle_metered_hire'], {
    title: 'Settle a metered-escrow hire (provider)',
    description: 'Charge the actual usage (≤ the deposited max) on a metered-escrow hire; the remainder is refunded to the buyer in the same on-chain tx. Must happen before auto_refund_at.',
    inputSchema: { hire_id: z.string().uuid(), actual_amount_usdc: z.number().nonnegative().optional(), units: z.number().nonnegative().optional() },
  }, async (a: any) => { const { hire_id, ...body } = a; return text(await api('POST', `/api/hires/${hire_id}/settle`, body)); });
}
