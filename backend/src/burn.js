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
  // Wait a moment in case buy was just settled
  for (let i=0;i<6;i++) await sleep(500);
  for (let attempt=1; attempt<=3; attempt++) {
    const out1 = await tryBurn(conn, kp, mintPk, TOKEN_PROGRAM_ID);
    if (out1) return out1;
    const out2 = await tryBurn(conn, kp, mintPk, TOKEN_2022_PROGRAM_ID);
    if (out2) return out2;
    await sleep(750);
  }
  console.log('[burn] nothing to burn');
  return null;
}
