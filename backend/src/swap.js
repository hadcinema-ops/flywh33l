import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
function keypairFromEnv() { const secret = process.env.SIGNER_SECRET_KEY; if (!secret) throw new Error('SIGNER_SECRET_KEY missing'); return Keypair.fromSecretKey(bs58.decode(secret)); }
function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
async function getSolBalanceLamports(conn, pubkey) { return await conn.getBalance(pubkey, { commitment: 'confirmed' }); }
export async function marketBuy() {
  const conn = rpc(); const kp = keypairFromEnv(); const outputMint = process.env.MINT_ADDRESS; if (!outputMint) throw new Error('MINT_ADDRESS not set');
  const reserveLamports = BigInt(Math.floor(Number(process.env.SOL_RESERVE || '0.01') * 1e9));
  const balance = BigInt(await getSolBalanceLamports(conn, kp.publicKey));
  const spendable = balance > reserveLamports ? (balance - reserveLamports) : 0n;
  const minLamports = BigInt(Math.floor(Number(process.env.MIN_SWAP_SOL || '0.001') * 1e9));
  if (spendable < minLamports) { console.log('[swap] not enough SOL'); return null; }
  const amountLamports = Number(spendable); const slippageBps = Number(process.env.SLIPPAGE_BPS || 150);
  const quoteResp = await axios.get('https://quote-api.jup.ag/v6/quote', { params: { inputMint: SOL_MINT, outputMint, amount: amountLamports, slippageBps, onlyDirectRoutes: false } });
  const quote = quoteResp.data; if (!quote || !quote.routes || quote.routes.length === 0) { console.log('[swap] no route'); return null; }
  const { data: swapTx } = await axios.post('https://quote-api.jup.ag/v6/swap', { quoteResponse: quote, userPublicKey: kp.publicKey.toBase64 ? kp.publicKey.toBase64() : kp.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: Number(process.env.PRIORITIZATION_FEE_LAMPORTS || 0) }, { headers: { 'Content-Type': 'application/json' } });
  const { swapTransaction } = swapTx; const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64')); tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const amountInSol = amountLamports / 1e9; const estTokensOut = Number(quote?.outAmount || 0);
  return { signature: sig, amountInSol, estTokensOut };
}
