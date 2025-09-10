import { claimCreatorFees } from './pump.js';
import { marketBuy } from './swap.js';
import { burnPurchased } from './burn.js';
import { getStats, saveStats } from './stats.js';

let inFlight = false;
let lastRun = { startedAt: 0, steps: [] };
export function getLastRun() { return lastRun; }

function step(name, data) { lastRun.steps.push({ t: Date.now(), name, data }); console.log(`[cycle] ${name}`, data ?? ''); }

export async function flywheelCycle() {
  if (inFlight) { console.log('[cycle] already running, skipping'); return { skipped: true }; }
  inFlight = true;
  lastRun = { startedAt: Date.now(), steps: [] };
  try {
    const stats = await getStats();
    step('begin', { totals: stats.totals });

    const claimSig = await claimCreatorFees();
    step('claim', { claimSig });
    if (claimSig) {
      stats.history.unshift({ ts: Date.now(), type: 'claim', signature: claimSig, link: `https://solscan.io/tx/${claimSig}` });
      stats.totals.claims += 1;
    }

    const buy = await marketBuy();
    step('buy', buy);
    if (buy?.signature) {
      stats.history.unshift({ ts: Date.now(), type: 'buy', signature: buy.signature, link: `https://solscan.io/tx/${buy.signature}`, amountInSol: buy.amountInSol, estTokensOut: buy.tokensOut || buy.estTokensOut || 0 });
      stats.totals.solSpent += buy.amountInSol || 0;
      stats.totals.tokensBought += buy.tokensOut || buy.estTokensOut || 0;
    }

    const burn = await burnPurchased();
    step('burn', burn);
    if (burn?.signature) {
      stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokens });
      stats.totals.tokensBurned += burn.amountTokens || 0;
    }

    stats.history = stats.history.slice(0, 200);
    await saveStats(stats);

    step('done', { totals: stats.totals });
    return { claimSig, buy, burn };
  } catch (e) {
    step('error', { error: String(e) });
    throw e;
  } finally {
    inFlight = false;
  }
}

export async function forceSync() {
  lastRun = { startedAt: Date.now(), steps: [] };
  const stats = await getStats();
  step('force-sync-start');
  const burn = await burnPurchased();
  step('force-sync-burn', burn);
  if (burn?.signature) {
    stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokens });
    stats.totals.tokensBurned += burn.amountTokens || 0;
  }
  await saveStats(stats);
  step('force-sync-done');
  return { burn };
}
