// Compute actual tokensOut by reading ATA before/after; confirm buy; retry reads.
// Works for Jupiter or PumpPortal Local.
import axios from 'axios';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
async function getSolBalanceLamports(conn, pubkey) { return await conn.getBalance(pubkey, { commitment: 'confirmed' }); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function getAtaPkAndInfo(conn, mintPk, ownerPk) {
  const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false);
  let acc = null;
  try { acc = await getAccount(conn, ata); } catch {}
  return { ata, acc };
}

async function confirmAndGetTokensOut(conn, mintPk, ownerPk, beforeAcc, sig) {
  try { await conn.confirmTransaction(sig, 'confirmed'); } catch {}
  // retry reads: up to 6 times over ~3s
  let afterAcc = null;
  for (let i=0;i<6;i++){
    try { afterAcc = await getAccount(conn, await getAssociatedTokenAddress(mintPk, ownerPk, false)); } catch {}
    if (afterAcc) break;
    await sleep(500);
  }
  const before = beforeAcc ? Number(beforeAcc.amount) : 0;
  const after = afterAcc ? Number(afterAcc.amount) : 0;
  const delta = Math.max(0, after - before);
  return { tokensOut: delta, afterAcc };
}

async function jupiterBuy(amountLamports, outputMint, kp, conn, mintPk, beforeAcc) {
  const slippageBps = Number(process.env.SLIPPAGE_BPS || 300);
  const quoteResp = await axios.get('https://quote-api.jup.ag/v6/quote', { params: { inputMint: SOL_MINT, outputMint, amount: amountLamports, slippageBps, onlyDirectRoutes: false } });
  const quote = quoteResp.data;
  if (!quote || !quote.routes || quote.routes.length === 0) return null;
  const { data: swapTx } = await axios.post('https://quote-api.jup.ag/v6/swap', { quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: Number(process.env.PRIORITIZATION_FEE_LAMPORTS || 0) }, { headers: { 'Content-Type': 'application/json' } });
  const { swapTransaction } = swapTx;
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const { tokensOut } = await confirmAndGetTokensOut(conn, mintPk, kp.publicKey, beforeAcc, sig);
  return { signature: sig, amountInSol: amountLamports / 1e9, tokensOut };
}

async function pumpLocalBuy(spendableLamports, outputMint, kp, conn, mintPk, beforeAcc) {
  const minSol = Number(process.env.MIN_PUMP_SOL || '0.01');
  const targetSol = Number(process.env.TARGET_PUMP_SOL || '0');
  const spendableSol = Number(spendableLamports) / 1e9;
  let amountSol = spendableSol;
  if (targetSol > 0) amountSol = Math.min(amountSol, targetSol);
  if (amountSol + 0.0005 < minSol) { console.log('[swap] spendable below MIN_PUMP_SOL; skipping'); return null; }
  amountSol = Math.max(minSol, amountSol - 0.0005);
  amountSol = Math.max(0, Math.min(amountSol, spendableSol));
  amountSol = Number(amountSol.toFixed(6));

  const body = {
    publicKey: kp.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    amount: amountSol.toFixed(6),
    denominatedInSol: true,
    slippage: Number(process.env.PUMP_SLIPPAGE_PCT || '3'),
    priorityFee: Number(process.env.PRIORITY_FEE_SOL || '0')
  };
  try {
    const { data, status } = await axios.post('https://pumpportal.fun/api/trade-local', body, { responseType: 'arraybuffer' });
    if (status !== 200) return null;
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([kp]);
    const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
    const { tokensOut } = await confirmAndGetTokensOut(conn, mintPk, kp.publicKey, beforeAcc, sig);
    return { signature: sig, amountInSol: amountSol, tokensOut };
  } catch (e) {
    const msg = e?.response?.data ? Buffer.from(e.response.data).toString('utf8') : (e.message || String(e));
    console.error('[swap:pump-local] buy error', msg);
    return null;
  }
}

export async function marketBuy() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const outputMint = process.env.MINT_ADDRESS;
  if (!outputMint) throw new Error('MINT_ADDRESS not set');
  const mintPk = new PublicKey(outputMint);

  // Read ATA before
  const { acc: beforeAcc } = await getAtaPkAndInfo(conn, mintPk, kp.publicKey);

  const reserveLamports = BigInt(Math.floor(Number(process.env.SOL_RESERVE || '0.01') * 1e9));
  const balance = BigInt(await getSolBalanceLamports(conn, kp.publicKey));
  const spendable = balance > reserveLamports ? (balance - reserveLamports) : 0n;
  const minLamports = BigInt(Math.floor(Number(process.env.MIN_SWAP_SOL || '0.001') * 1e9));
  if (spendable < minLamports) { console.log('[swap] not enough SOL'); return null; }

  const provider = (process.env.SWAP_PROVIDER || 'auto').toLowerCase();
  try {
    if (provider === 'pump') {
      const pumpRes = await pumpLocalBuy(spendable, outputMint, kp, conn, mintPk, beforeAcc);
      if (pumpRes) return pumpRes;
      console.log('[swap] pump local buy failed'); return null;
    }
    const amountLamports = Number(spendable);
    const jupRes = await jupiterBuy(amountLamports, outputMint, kp, conn, mintPk, beforeAcc);
    if (jupRes) return jupRes;
    if (provider === 'jupiter') { console.log('[swap] no route (jupiter only)'); return null; }
    console.log('[swap] no route on Jupiter — falling back to PumpPortal Local buy');
    const pumpRes = await pumpLocalBuy(spendable, outputMint, kp, conn, mintPk, beforeAcc);
    if (pumpRes) return pumpRes;
    console.log('[swap] no route and pump fallback failed');
    return null;
  } catch (e) {
    const msg = e?.response?.data ? Buffer.from(e.response.data).toString('utf8') : (e.message || String(e));
    console.error('[swap] error', msg);
    return null;
  }
}
