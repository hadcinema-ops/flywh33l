// src/burn.js (v7)
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
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

const INCINERATOR_OWNER = new PublicKey('1nc1nerator11111111111111111111111111111111');

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

  // Give post-buy balances time to settle/create ATAs
  for (let i = 0; i < 10; i++) await wait(500);

  const { picked } = await probeBalances(conn, mintPk, kp.publicKey);
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

  // 2) Fallback: transfer ALL to incinerator's *token account* (ATA). Create it if missing.
  const incAta = await getAssociatedTokenAddress(
    mintPk, INCINERATOR_OWNER, false, picked.programId, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  let incAtaExists = true;
  try { await getAccount(conn, incAta, undefined, picked.programId); } catch { incAtaExists = false; }

  const ixs = [];
  if (!incAtaExists) {
    ixs.push(createAssociatedTokenAccountInstruction(
      kp.publicKey,       // payer
      incAta,             // ATA to create
      INCINERATOR_OWNER,  // owner of ATA
      mintPk,             // mint
      picked.programId,   // token program
      ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }
  ixs.push(createTransferCheckedInstruction(
    picked.ata, mintPk, incAta, kp.publicKey, BigInt(picked.amount), picked.decimals, [], picked.programId
  ));
  // Optional: close our now-empty ATA to reclaim rent
  ixs.push(createCloseAccountInstruction(picked.ata, kp.publicKey, kp.publicKey, [], picked.programId));

  const sig = await sendTx(conn, kp, ixs);
  return { signature: sig, amountTokensRaw: picked.amount, amountTokensUi: picked.amount / (10 ** picked.decimals) };
}
