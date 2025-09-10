import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createBurnCheckedInstruction, getMint, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import axios from 'axios';
function rpc() { const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'; return new Connection(url, 'confirmed'); }
function keypairFromEnv() { const secret = process.env.SIGNER_SECRET_KEY; if (!secret) throw new Error('SIGNER_SECRET_KEY missing'); return Keypair.fromSecretKey(bs58.decode(secret)); }
export async function burnPurchased() {
  const conn = rpc(); const kp = keypairFromEnv(); const mintPk = new PublicKey(process.env.MINT_ADDRESS);
  const ata = await getAssociatedTokenAddress(mintPk, kp.publicKey, false);
  const mintInfo = await getMint(conn, mintPk);
  let tokenAcc; try { tokenAcc = await getAccount(conn, ata); } catch { console.log('[burn] no token account'); return null; }
  const amount = tokenAcc.amount; if (amount <= 0n) { console.log('[burn] nothing to burn'); return null; }
  if (process.env.USE_INCINERATOR === 'true') {
    try { const { data } = await axios.post('https://api.sol-incinerator.com/v1/burn', { mint: mintPk.toBase58(), owner: kp.publicKey.toBase58(), amount: amount.toString() }, { headers: { 'Content-Type': 'application/json' } }); return { signature: data?.signature || null, amountTokens: Number(amount) }; }
    catch (e) { console.log('[burn] incinerator failed'); }
  }
  const ix = createBurnCheckedInstruction(ata, mintPk, kp.publicKey, amount, mintInfo.decimals);
  const tx = new Transaction().add(ix); tx.feePayer = kp.publicKey;
  const sig = await conn.sendTransaction(tx, { signers: [kp] });
  return { signature: sig, amountTokens: Number(amount) };
}
