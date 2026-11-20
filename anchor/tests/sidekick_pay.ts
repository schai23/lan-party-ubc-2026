import * as anchor from "@anchor-lang/core";
import { BN, EventParser, Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { SidekickPay } from "../target/types/sidekick_pay";

const USDC = 1_000_000; // 6 decimals
const UNIT_PRICE = 1_000; // 0.001 USDC per unit
const WEIGHTS = [10, 20, 2, 1];

describe("sidekick_pay", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SidekickPay as Program<SidekickPay>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const settler = Keypair.generate();
  const treasury = Keypair.generate();
  const helper = Keypair.generate();
  const stranger = Keypair.generate();

  let mint: PublicKey;
  let treasuryAta: PublicKey;
  let helperAta: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [helperStatsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("helper"), helper.publicKey.toBuffer()],
    program.programId,
  );
  const sessionPda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("session"), treasury.publicKey.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  const vaultOf = (session: PublicKey) => getAssociatedTokenAddressSync(mint, session, true);

  const parser = () => new EventParser(program.programId, program.coder);
  async function eventsOf(sig: string) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return [...parser().parseLogs(tx?.meta?.logMessages ?? [])];
  }
  const balance = async (ata: PublicKey) => Number((await getAccount(conn, ata, "confirmed")).amount);

  async function openSession(id: number, budget: number) {
    const session = sessionPda(id);
    return program.methods
      .openSession(new BN(id), new BN(budget))
      .accountsPartial({
        treasury: treasury.publicKey,
        config: configPda,
        session,
        usdcMint: mint,
        treasuryAta,
        vault: vaultOf(session),
      })
      .signers([treasury])
      .rpc({ commitment: "confirmed" });
  }

  function settleIx(id: number, units: number, signer: Keypair) {
    const session = sessionPda(id);
    return program.methods
      .settle(new BN(id), new BN(units), Array.from(Buffer.alloc(32, units % 256)))
      .accountsPartial({
        settler: signer.publicKey,
        config: configPda,
        treasury: treasury.publicKey,
        session,
        vault: vaultOf(session),
        helper: helper.publicKey,
        helperStats: helperStatsPda,
        helperAta,
      })
      .signers([signer]);
  }

  function closeIx(id: number) {
    const session = sessionPda(id);
    return program.methods
      .closeSession(new BN(id))
      .accountsPartial({
        settler: settler.publicKey,
        config: configPda,
        treasury: treasury.publicKey,
        session,
        vault: vaultOf(session),
        treasuryAta,
      })
      .signers([settler]);
  }

  before(async () => {
    for (const kp of [settler, treasury, stranger]) {
      const sig = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    mint = await createMint(conn, payer, payer.publicKey, null, 6, undefined, { commitment: "confirmed" });
    const confirmed = { commitment: "confirmed" as const };
    treasuryAta = await createAssociatedTokenAccount(conn, payer, mint, treasury.publicKey, confirmed);
    helperAta = await createAssociatedTokenAccount(conn, payer, mint, helper.publicKey, confirmed);
    await mintTo(conn, payer, mint, treasuryAta, payer, 20 * USDC, [], { commitment: "confirmed" });

    await program.methods
      .initializeConfig(new BN(UNIT_PRICE), WEIGHTS, settler.publicKey)
      .accountsPartial({ admin: payer.publicKey, config: configPda, usdcMint: mint })
      .rpc({ commitment: "confirmed" });

    await program.methods
      .registerHelper(helper.publicKey)
      .accountsPartial({ settler: settler.publicKey, config: configPda, helperStats: helperStatsPda })
      .signers([settler])
      .rpc({ commitment: "confirmed" });
  });

  it("stores config", async () => {
    const c = await program.account.config.fetch(configPda);
    assert.ok(c.admin.equals(payer.publicKey));
    assert.ok(c.settler.equals(settler.publicKey));
    assert.ok(c.usdcMint.equals(mint));
    assert.equal(c.unitPrice.toNumber(), UNIT_PRICE);
    assert.deepEqual(c.jobWeights, WEIGHTS);
  });

  it("open -> settle twice -> close", async () => {
    const id = 1;
    const budget = 5 * USDC;
    const session = sessionPda(id);
    const vault = vaultOf(session);

    const openSig = await openSession(id, budget);
    const openEv = await eventsOf(openSig);
    assert.equal(openEv[0].name, "sessionOpened");
    assert.ok(openEv[0].data.session.equals(session));
    assert.ok(openEv[0].data.treasury.equals(treasury.publicKey));
    assert.equal(openEv[0].data.budget.toNumber(), budget);
    assert.equal(await balance(vault), budget);
    assert.equal(await balance(treasuryAta), 15 * USDC);

    // settle #1: 1000 units = 1 USDC
    const s1 = await settleIx(id, 1000, settler).rpc({ commitment: "confirmed" });
    const e1 = await eventsOf(s1);
    assert.equal(e1[0].name, "jobsSettled");
    assert.ok(e1[0].data.helper.equals(helper.publicKey));
    assert.equal(e1[0].data.units.toNumber(), 1000);
    assert.equal(e1[0].data.amount.toNumber(), 1 * USDC);
    assert.equal(e1[0].data.totalUnits.toNumber(), 1000);
    assert.equal(e1[0].data.totalEarned.toNumber(), 1 * USDC);
    assert.deepEqual(Array.from(e1[0].data.receiptsRoot), Array.from(Buffer.alloc(32, 1000 % 256)));

    // settle #2: 500 units = 0.5 USDC
    const s2 = await settleIx(id, 500, settler).rpc({ commitment: "confirmed" });
    const e2 = await eventsOf(s2);
    assert.equal(e2[0].data.units.toNumber(), 500);
    assert.equal(e2[0].data.amount.toNumber(), USDC / 2);
    assert.equal(e2[0].data.totalUnits.toNumber(), 1500);
    assert.equal(e2[0].data.totalEarned.toNumber(), 1.5 * USDC);

    assert.equal(await balance(helperAta), 1.5 * USDC);
    assert.equal(await balance(vault), 3.5 * USDC);

    const s = await program.account.session.fetch(session);
    assert.equal(s.spent.toNumber(), 1.5 * USDC);
    assert.equal(s.unitsPaid.toNumber(), 1500);
    assert.isTrue(s.open);
    const h = await program.account.helperStats.fetch(helperStatsPda);
    assert.equal(h.settlements, 2);
    assert.equal(h.totalUnits.toNumber(), 1500);

    const closeSig = await closeIx(id).rpc({ commitment: "confirmed" });
    const ce = await eventsOf(closeSig);
    assert.equal(ce[0].name, "sessionClosed");
    assert.ok(ce[0].data.session.equals(session));
    assert.equal(ce[0].data.refunded.toNumber(), 3.5 * USDC);
    assert.equal(await balance(vault), 0);
    assert.equal(await balance(treasuryAta), 18.5 * USDC);
    assert.isFalse((await program.account.session.fetch(session)).open);

    // settling a closed session fails
    try {
      await settleIx(id, 1, settler).rpc();
      assert.fail("settle on closed session should fail");
    } catch (e: any) {
      assert.include(String(e), "SessionClosed");
    }
  });

  it("settle over budget fails", async () => {
    const id = 2;
    await openSession(id, 1 * USDC);
    try {
      await settleIx(id, 1001, settler).rpc();
      assert.fail("over-budget settle should fail");
    } catch (e: any) {
      assert.include(String(e), "OverBudget");
    }
    // exactly the budget is fine
    await settleIx(id, 1000, settler).rpc({ commitment: "confirmed" });
    assert.equal(await balance(vaultOf(sessionPda(id))), 0);
    try {
      await settleIx(id, 1, settler).rpc();
      assert.fail("settle past exhausted budget should fail");
    } catch (e: any) {
      assert.include(String(e), "OverBudget");
    }
  });

  it("non-settler settle fails", async () => {
    const id = 3;
    await openSession(id, 1 * USDC);
    const before = await balance(helperAta);
    try {
      await settleIx(id, 10, stranger).rpc();
      assert.fail("non-settler settle should fail");
    } catch (e: any) {
      assert.include(String(e), "NotSettler");
    }
    assert.equal(await balance(helperAta), before);
    assert.equal(await balance(vaultOf(sessionPda(id))), 1 * USDC);
  });
});
