// Swap with Jupiter by default; if no route or SWAP_PROVIDER='pump', fall back to PumpPortal Local buy
import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
async function getSolBalanceLamports(conn, pubkey) { return await conn.getBalance(pubkey, { commitment: 'confirmed' }); }

async function jupiterSwap(amountLamports, outputMint, kp, conn) {
  const slippageBps = Number(process.env.SLIPPAGE_BPS || 300); // widen a bit
  const quoteResp = await axios.get('https://quote-api.jup.ag/v6/quote', {
    params: { inputMint: SOL_MINT, outputMint, amount: amountLamports, slippageBps, onlyDirectRoutes: false }
  });
  const quote = quoteResp.data;
  if (!quote || !quote.routes || quote.routes.length === 0) return null;
  const { data: swapTx } = await axios.post('https://quote-api.jup.ag/v6/swap', {
    quoteResponse: quote,
    userPublicKey: kp.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: Number(process.env.PRIORITIZATION_FEE_LAMPORTS || 0)
  }, { headers: { 'Content-Type': 'application/json' } });
  const { swapTransaction } = swapTx;
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  return { signature: sig, amountInSol: amountLamports / 1e9, estTokensOut: Number(quote?.outAmount || 0) };
}

async function pumpLocalBuy(amountLamports, outputMint, kp, conn) {
  // Use PumpPortal Local buy (no API key). Amount denominated in SOL.
  const { data, status } = await axios.post('https://pumpportal.fun/api/trade-local', {
    publicKey: kp.publicKey.toBase58(),
    action: 'buy',
    mint: outputMint,
    denominatedInSol: true,
    amount: String(Math.max(1, amountLamports)) // as string; ensure >0
  }, { responseType: 'arraybuffer' });
  if (status !== 200) return null;
  const tx = VersionedTransaction.deserialize(new Uint8Array(data));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  return { signature: sig, amountInSol: amountLamports / 1e9, estTokensOut: 0 };
}

export async function marketBuy() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const outputMint = process.env.MINT_ADDRESS;
  if (!outputMint) throw new Error('MINT_ADDRESS not set');

  const reserveLamports = BigInt(Math.floor(Number(process.env.SOL_RESERVE || '0.01') * 1e9));
  const balance = BigInt(await getSolBalanceLamports(conn, kp.publicKey));
  const spendable = balance > reserveLamports ? (balance - reserveLamports) : 0n;
  const minLamports = BigInt(Math.floor(Number(process.env.MIN_SWAP_SOL || '0.001') * 1e9));
  if (spendable < minLamports) { console.log('[swap] not enough SOL'); return null; }
  const amountLamports = Number(spendable);

  const provider = (process.env.SWAP_PROVIDER || 'auto').toLowerCase(); // auto | jupiter | pump
  try {
    if (provider === 'pump') {
      const pumpRes = await pumpLocalBuy(amountLamports, outputMint, kp, conn);
      if (pumpRes) return pumpRes;
      console.log('[swap] pump local buy failed'); return null;
    }

    // Try Jupiter first (auto or jupiter)
    const jupRes = await jupiterSwap(amountLamports, outputMint, kp, conn);
    if (jupRes) return jupRes;

    if (provider === 'jupiter') {
      console.log('[swap] no route (jupiter only)'); return null;
    }

    // Auto fallback: PumpPortal Local
    console.log('[swap] no route on Jupiter — falling back to PumpPortal Local buy');
    const pumpRes = await pumpLocalBuy(amountLamports, outputMint, kp, conn);
    if (pumpRes) return pumpRes;

    console.log('[swap] no route and pump fallback failed');
    return null;
  } catch (e) {
    console.error('[swap] error', e?.response?.data || e.message || e);
    return null;
  }
}
