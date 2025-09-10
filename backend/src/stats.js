import { promises as fs } from 'fs';
const DB_PATH = process.env.DB_PATH || './db.json';
const defaultStats = {
  config: {
    mint: process.env.MINT_ADDRESS || '',
    dev: process.env.DEV_PUBLIC_KEY || '',
    network: process.env.RPC_URL?.includes('devnet') ? 'devnet' : 'mainnet',
  },
  totals: { claims: 0, solSpent: 0, tokensBought: 0, tokensBurned: 0 },
  history: []
};
export async function initStats() {
  try { await fs.access(DB_PATH); } catch { await fs.writeFile(DB_PATH, JSON.stringify(defaultStats, null, 2)); }
}
export async function getStats() {
  try { const raw = await fs.readFile(DB_PATH, 'utf8'); return JSON.parse(raw); }
  catch { return defaultStats; }
}
export async function saveStats(obj) { await fs.writeFile(DB_PATH, JSON.stringify(obj, null, 2)); }
