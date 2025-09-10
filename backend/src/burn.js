// src/burn.js
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
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

const INCINERATOR = new PublicKey(
  '1nc1nerator11111111111111111111111111111111'
);

function rpc() {
  const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}
function keypairFromEnv() {
  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) throw new Error('SIGNER_SECRET_KEY missing');
  return Keypair.fromSecretKey(bs58.decode(secret));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAta(conn, mintPk, ownerPk, programId) {
  const ata = await getAssociatedTokenAddress(
    mintPk,
    ownerPk,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  let acc = null;
  try {
    acc = await getAccount(conn, ata, undefined, programId);
  } catch {}
  return { ata, acc };
}

async function tryBurnAll(conn, kp, mintPk, programId) {
  const { ata, acc } = await getAta(conn, mintPk, kp.publicKey, programId);
  if (!acc || acc.amount <= 0n) return null;

  const mintInfo = await getMint(conn, mintPk, undefined, programId);
  const cuIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: Math.max(
      0,
      Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '2000')
    ), // ~0.000002 SOL/compute unit
  });

  const burnIx = createBurnCheckedInstruction(
    ata,
    mintPk,
    kp.publicKey,
    acc.amount, // bigint
    mintInfo.decimals,
    [],
    programId
  );

  const tx = new Transaction().add(cuIx, burnIx);
  tx.feePayer = kp.publicKey;

  const sig = await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
  return {
    signature: sig,
    amountTokensRaw: Number(acc.amount),
    amountTokensUi: Number(acc.amount) / 10 ** mintInfo.decimals,
  };
}

async function transferAllToIncinerator(conn, kp, mintPk, programId) {
  const { ata, acc } = await getAta(conn, mintPk, kp.publicKey, programId);
  if (!acc || acc.amount <= 0n) return null;

  const mintInfo = await getMint(conn, mintPk, undefined, programId);
  const cuIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: Math.max(
      0,
      Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '2000')
    ),
  });

  const xferIx = createTransferCheckedInstruction(
    ata,
    mintPk,
    INCINERATOR,
    kp.publicKey,
    acc.amount,
    mintInfo.decimals,
    [],
    programId
  );

  // Optional: close ATA after sending to reclaim rent (safe once balance is 0)
  const closeIx = createCloseAccountInstruction(
    ata,
    kp.publicKey,
    kp.publicKey,
    [],
    programId
  );

  const tx = new Transaction().add(cuIx, xferIx, closeIx);
  tx.feePayer = kp.publicKey;

  const sig = await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
  return {
    signature: sig,
    amountTokensRaw: Number(acc.amount),
    amountTokensUi: Number(acc.amount) / 10 ** mintInfo.decimals,
  };
}

export async function burnPurchased() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const mintPk = new PublicKey(process.env.MINT_ADDRESS);

  // Let post-buy balance settle
  for (let i = 0; i < 8; i++) await wait(500);

  // 1) Try Token-2022 true burn
  try {
    const out = await tryBurnAll(conn, kp, mintPk, TOKEN_2022_PROGRAM_ID);
    if (out) return out;
  } catch {}

  // 2) Try classic SPL true burn
  try {
    const out = await tryBurnAll(conn, kp, mintPk, TOKEN_PROGRAM_ID);
    if (out) return out;
  } catch {}

  // 3) Fallback: transfer ALL to Incinerator (works with either program)
  let out = await transferAllToIncinerator(conn, kp, mintPk, TOKEN_2022_PROGRAM_ID);
  if (out) return out;

  out = await transferAllToIncinerator(conn, kp, mintPk, TOKEN_PROGRAM_ID);
  if (out) return out;

  console.log('[burn] nothing to burn');
  return null;
}
