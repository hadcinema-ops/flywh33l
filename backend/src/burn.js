// src/burn.js
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getMint,
  getAccount,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');

function rpc() {
  const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}
function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function probeBalances(conn, mintPk, ownerPk) {
  async function get(programId) {
    const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
      const acc = await getAccount(conn, ata, undefined, programId);
      const mint = await getMint(conn, mintPk, undefined, programId);
      return { programId, ata, acc, mint, amount: Number(acc.amount), decimals: mint.decimals };
    } catch {
      return { programId, ata, acc: null, mint: null, amount: 0, decimals: 0 };
    }
  }
  const classic = await get(TOKEN_PROGRAM_ID);
  const t22 = await get(TOKEN_2022_PROGRAM_ID);
  // Prefer whichever actually holds a positive balance; if both, prefer Token-2022
  const picked = (t22.amount > 0) ? t22 : (classic.amount > 0 ? classic : null);
  return { classic, t22, picked };
}

async function sendTx(conn, kp, ixs) {
  const pri = Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '2000');
  const cuIx = pri ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, pri) }) : null;
  const tx = new Transaction();
  if (cuIx) tx.add(cuIx);
  ixs.forEach(ix => tx.add(ix));
  tx.feePayer = kp.publicKey;
  return await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
}

export async function burnPurchased() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const mintPk = new PublicKey(process.env.MINT_ADDRESS);

  // Let post-buy settle
  for (let i = 0; i < 8; i++) await wait(500);

  const { picked, classic, t22 } = await probeBalances(conn, mintPk, kp.publicKey);
  if (!picked || picked.amount <= 0) {
    console.log('[burn] nothing to burn (no positive balance found)');
    return null;
  }

  // 1) Try true burn (burnChecked) under the program that actually holds the balance
  try {
    const burnIx = createBurnCheckedInstruction(
      picked.ata, mintPk, kp.publicKey, BigInt(picked.amount), picked.decimals, [], picked.programId
    );
    const sig = await sendTx(conn, kp, [burnIx]);
    return { signature: sig, amountTokensRaw: picked.amount, amountTokensUi: picked.amount / (10 ** picked.decimals) };
  } catch (e) {
    console.log('[burn] burnChecked failed, falling back to incinerator:', e?.message || e);
  }

  // 2) Fallback: transfer ALL to incinerator + close ATA (works reliably)
  try {
    const xferIx = createTransferCheckedInstruction(
      picked.ata, mintPk, INCINERATOR, kp.publicKey, BigInt(picked.amount), picked.decimals, [], picked.programId
    );
    const closeIx = createCloseAccountInstruction(picked.ata, kp.publicKey, kp.publicKey, [], picked.programId);
    const sig = await sendTx(conn, kp, [xferIx, closeIx]);
    return { signature: sig, amountTokensRaw: picked.amount, amountTokensUi: picked.amount / (10 ** picked.decimals) };
  } catch (e) {
    console.log('[burn] incinerator fallback failed:', e?.message || e);
  }

  console.log('[burn] failed to burn or transfer to incinerator');
  return null;
}
