import { claimCreatorFees } from './pump.js';
import { marketBuy } from './swap.js';
import { burnPurchased, getTokenBalances } from './burn.js';
import { getStats, saveStats } from './stats.js';

let inFlight = false;

export async function flywheelCycle() {
  if (inFlight) { console.log('[cycle] already running, skipping'); return { skipped: true }; }
  inFlight = true;
  try {
    const stats = await getStats();

    const claimSig = await claimCreatorFees();
    if (claimSig) {
      stats.history.unshift({ ts: Date.now(), type: 'claim', signature: claimSig, link: `https://solscan.io/tx/${claimSig}` });
      stats.totals.claims += 1;
    }

    const buy = await marketBuy();
    if (buy?.signature) {
      stats.history.unshift({ ts: Date.now(), type: 'buy', signature: buy.signature, link: `https://solscan.io/tx/${buy.signature}`, amountInSol: buy.amountInSol, estTokensOut: buy.tokensOut || buy.estTokensOut || 0 });
      stats.totals.solSpent += buy.amountInSol || 0;
      stats.totals.tokensBought += buy.tokensOut || buy.estTokensOut || 0;
    }

    const burn = await burnPurchased();
    if (burn?.signature) {
      stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokens });
      stats.totals.tokensBurned += burn.amountTokens || 0;
    }

    stats.history = stats.history.slice(0, 200);
    await saveStats(stats);
    return { claimSig, buy, burn };
  } finally {
    inFlight = false;
  }
}

export async function forceSync() {
  const stats = await getStats();
  const balances = await getTokenBalances();
  // no totals change; only try a burn and ensure history reflects it
  const burn = await burnPurchased();
  if (burn?.signature) {
    stats.history.unshift({ ts: Date.now(), type: 'burn', signature: burn.signature, link: `https://solscan.io/tx/${burn.signature}`, amountTokens: burn.amountTokens });
    stats.totals.tokensBurned += burn.amountTokens || 0;
  }
  await saveStats(stats);
  return { balances, burn };
}
