// Burn works for classic SPL or Token-2022 by trying both program IDs.
// Also waits briefly post-buy so the ATA has time to settle.
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createBurnCheckedInstruction, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
function keypairFromEnv() { const secret = process.env.SIGNER_SECRET_KEY; if (!secret) throw new Error('SIGNER_SECRET_KEY missing'); return Keypair.fromSecretKey(bs58.decode(secret)); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function tryBurn(conn, kp, mintPk, programId) {
  const ata = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, programId);
  let mintInfo;
  try { mintInfo = await getMint(conn, mintPk, undefined, programId); } catch { return null; }
  let tokenAcc;
  try { tokenAcc = await getAccount(conn, ata, undefined, programId); } catch { return null; }
  const amount = tokenAcc.amount;
  if (amount <= 0n) return null;
  const ix = createBurnCheckedInstruction(ata, mintPk, kp.publicKey, amount, mintInfo.decimals, [], programId);
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  const sig = await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
  return { signature: sig, amountTokens: Number(amount) };
}

export async function burnPurchased() {
  const conn = rpc(); const kp = keypairFromEnv(); const mintPk = new PublicKey(process.env.MINT_ADDRESS);
  // small wait in case buy just happened
  await sleep(700);
  // Try classic SPL first, then Token-2022
  let out = await tryBurn(conn, kp, mintPk, TOKEN_PROGRAM_ID);
  if (out) return out;
  out = await tryBurn(conn, kp, mintPk, TOKEN_2022_PROGRAM_ID);
  if (out) return out;
  console.log('[burn] nothing to burn or program mismatch');
  return null;
}
