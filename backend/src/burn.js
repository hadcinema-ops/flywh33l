// Incinerator-first burn; falls back to SPL/Token-2022 with proper decimals and ATA programs.
import axios from 'axios';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createBurnCheckedInstruction, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { ensureDecimals, toUi } from './stats.js';

function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
function keypairFromEnv() { const secret = process.env.SIGNER_SECRET_KEY; if (!secret) throw new Error('SIGNER_SECRET_KEY missing'); return Keypair.fromSecretKey(bs58.decode(secret)); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function trySplBurn(conn, kp, mintPk, programId, decimals) {
  const ata = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
  let mintInfo;
  try { mintInfo = await getMint(conn, mintPk, undefined, programId); } catch { return null; }
  let tokenAcc;
  try { tokenAcc = await getAccount(conn, ata, undefined, programId); } catch { return null; }
  const amountRaw = tokenAcc.amount;
  if (amountRaw <= 0n) return null;
  const ix = createBurnCheckedInstruction(ata, mintPk, kp.publicKey, amountRaw, mintInfo.decimals, [], programId);
  const tx = new Transaction().add(ix); tx.feePayer = kp.publicKey;
  const sig = await conn.sendTransaction(tx, { signers: [kp], maxRetries: 3 });
  return { signature: sig, amountTokensRaw: Number(amountRaw), amountTokensUi: toUi(Number(amountRaw), decimals) };
}

async function tryIncinerator(conn, kp, mintPk, decimals) {
  try {
    const { data } = await axios.post('https://api.sol-incinerator.com/v1/burn', {
      mint: mintPk.toBase58(),
      owner: kp.publicKey.toBase58(),
      amount: 'ALL'
    }, { headers: { 'Content-Type': 'application/json' } });
    if (!data?.signature) return null;
    return { signature: data.signature, amountTokensRaw: 0, amountTokensUi: 0 };
  } catch (e) {
    const msg = e?.response?.data ? (typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)) : (e.message || String(e));
    console.log('[incinerator] error', msg);
    return null;
  }
}

export async function burnPurchased() {
  const conn = rpc(); const kp = keypairFromEnv();
  const decimals = await ensureDecimals() ?? 6;
  const mintPk = new PublicKey(process.env.MINT_ADDRESS);

  for (let i=0;i<6;i++) await sleep(500);

  if (String(process.env.USE_INCINERATOR).toLowerCase() === 'true') {
    const inc = await tryIncinerator(conn, kp, mintPk, decimals);
    if (inc?.signature) return inc;
  }

  for (let attempt=1; attempt<=3; attempt++) {
    const out1 = await trySplBurn(conn, kp, mintPk, TOKEN_PROGRAM_ID, decimals);
    if (out1?.signature) return out1;
    const out2 = await trySplBurn(conn, kp, mintPk, TOKEN_2022_PROGRAM_ID, decimals);
    if (out2?.signature) return out2;
    await sleep(750);
  }
  console.log('[burn] nothing to burn');
  return null;
}
