// src/burn.js (true-burn only, v7.1)
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getMint,
  getAccount,
  createBurnCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

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

async function probeBalanceAndMint(conn, mintPk, ownerPk) {
  async function probe(programId) {
    const ata = await getAssociatedTokenAddress(mintPk, ownerPk, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
      const acc = await getAccount(conn, ata, undefined, programId);
      const mint = await getMint(conn, mintPk, undefined, programId);
      return { programId, ata, acc, mint, amount: Number(acc.amount), decimals: mint.decimals };
    } catch {
      return { programId, ata, acc: null, mint: null, amount: 0, decimals: 0 };
    }
  }
  const t22 = await probe(TOKEN_2022_PROGRAM_ID);
  const spl = await probe(TOKEN_PROGRAM_ID);
  // Prefer the program that actually holds a positive balance; else null
  return (t22.amount > 0) ? t22 : (spl.amount > 0 ? spl : null);
}

export async function burnPurchased() {
  const conn = rpc();
  const kp = keypairFromEnv();
  const mintPk = new PublicKey(process.env.MINT_ADDRESS);

  // Allow time for post-buy settlement and ATA creation
  for (let i = 0; i < 10; i++) await wait(500);

  const target = await probeBalanceAndMint(conn, mintPk, kp.publicKey);
  if (!target || target.amount <= 0) {
    console.log('[burn] nothing to burn (no positive balance found)');
    return null;
  }

  const { programId, ata, amount, decimals } = target;

  // Build burnChecked
  const burnIx = createBurnCheckedInstruction(
    ata,
    mintPk,
    kp.publicKey,
    BigInt(amount),          // amount in base units (bigint)
    decimals,                // mint decimals from on-chain
    [],
    programId
  );

  // Small priority fee to avoid congestion edge cases
  const pri = Number(process.env.PRIORITY_FEE_MICROLAMPORTS || '2000');
  const cuIx = pri ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, pri) }) : null;

  const tx = new Transaction();
  if (cuIx) tx.add(cuIx);
  tx.add(burnIx);
  tx.feePayer = kp.publicKey;

  // Simulate first for clear logs if something is off
  try {
    const sim = await conn.simulateTransaction(tx, [kp]);
    if (sim?.value?.err) {
      console.error('[burn] simulate err:', sim.value.err);
      if (sim?.value?.logs) console.error('[burn] logs:', sim.value.logs);
      throw new Error('Simulation failed');
    }
  } catch (e) {
    // proceed to send anyway, but we logged details
  }

  try {
    const sig = await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
    return { signature: sig, amountTokensRaw: amount, amountTokensUi: amount / (10 ** decimals) };
  } catch (sendErr) {
    // One more simulation to fetch logs for debugging
    try {
      const sim = await conn.simulateTransaction(tx, [kp]);
      if (sim?.value?.logs) console.error('[burn] logs (post-send failure):', sim.value.logs);
    } catch {}
    throw sendErr;
  }
}
