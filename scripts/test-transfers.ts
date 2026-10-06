// ==============================================================================
// Comprehensive Test Suite: Atomic Transfers & Race Condition Verification
//
// How to run:
//   npm run test:transfers
//   OR
//   npx tsx scripts/test-transfers.ts
//
// Requirements before running:
//   PostgreSQL container must be running (docker compose up -d postgres)
// ==============================================================================

import dotenv from "dotenv";
import path from "path";

// Ensure environment variables are loaded
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import {
  initDatabase,
  checkDatabaseConnection,
  closeDatabaseConnection,
  createAccount,
  getAccountById,
  executeTransferPayment,
  TransferError,
} from "@payment/database";

// Helper to format currency
const fmt = (n: number | string | undefined) => `$${Number(n || 0).toFixed(2)}`;

async function main() {
  console.log("================================================================================");
  console.log("       MINI PAYMENT SYSTEM - ATOMIC TRANSFERS & RACE CONDITION TEST SUITE       ");
  console.log("================================================================================\n");

  // 1. Verify DB Connection
  const dbCheck = await checkDatabaseConnection();
  if (!dbCheck.connected) {
    console.error(" [ERROR] Cannot connect to PostgreSQL!");
    console.error(`         Detail: ${dbCheck.error}`);
    console.error("         Hint: Ensure PostgreSQL is running with `docker compose up -d postgres`");
    process.exit(1);
  }

  await initDatabase();
  console.log(" [SETUP] PostgreSQL connected & tables verified.\n");

  let passedTests = 0;
  const totalTests = 7;

  // ----------------------------------------------------------------------------
  // TEST 1: Baseline Happy Path Transfer ($300.00)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 1: Baseline Single Transfer ($300.00)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 200.0, currency: "USD" });
    console.log(`Initial Balances: Account A = ${fmt(accA.balance)} | Account B = ${fmt(accB.balance)}`);

    const payment = await executeTransferPayment({
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    const updatedA = await getAccountById(accA.id);
    const updatedB = await getAccountById(accB.id);

    console.log(`Payment Status:   ${payment.status} (ID: ${payment.id})`);
    console.log(`Final Balances:   Account A = ${fmt(updatedA?.balance)} (expected: $700.00) | Account B = ${fmt(updatedB?.balance)} (expected: $500.00)`);

    if (
      payment.status === "COMPLETED" &&
      Number(updatedA?.balance) === 700.0 &&
      Number(updatedB?.balance) === 500.0
    ) {
      console.log(">>> RESULT: [PASS]\n");
      passedTests++;
    } else {
      throw new Error("Test 1 failed: Balances or status did not match expected values.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 2: Insufficient Balance Rejection
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 2: Insufficient Balance Rejection (Zero State Leakage)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accC = await createAccount({ balance: 100.0, currency: "USD" });
    const accD = await createAccount({ balance: 50.0, currency: "USD" });
    console.log(`Initial Balances: Account C = ${fmt(accC.balance)} | Account D = ${fmt(accD.balance)}`);
    console.log("Attempting transfer of $300.00 (which exceeds $100.00 balance)...");

    let expectedErrorCaught = false;
    try {
      await executeTransferPayment({
        source_account_id: accC.id,
        destination_account_id: accD.id,
        amount: 300.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 400) {
        expectedErrorCaught = true;
        console.log(`Caught Expected Error: "${err.message}"`);
      }
    }

    const updatedC = await getAccountById(accC.id);
    const updatedD = await getAccountById(accD.id);

    console.log(`Final Balances:   Account C = ${fmt(updatedC?.balance)} (expected: $100.00) | Account D = ${fmt(updatedD?.balance)} (expected: $50.00)`);

    if (
      expectedErrorCaught &&
      Number(updatedC?.balance) === 100.0 &&
      Number(updatedD?.balance) === 50.0
    ) {
      console.log(">>> RESULT: [PASS]\n");
      passedTests++;
    } else {
      throw new Error("Test 2 failed: Balances were altered despite insufficient funds.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 3: Mid-Transaction Failure -> Clean Rollback
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 3: Mid-Transaction Failure Clean Rollback (Currency Mismatch)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accE = await createAccount({ balance: 500.0, currency: "USD" });
    const accF = await createAccount({ balance: 100.0, currency: "EUR" }); // Currency mismatch
    console.log(`Initial Balances: Account E = ${fmt(accE.balance)} USD | Account F = ${fmt(accF.balance)} EUR`);
    console.log("Attempting transfer with mismatching currency (USD -> EUR)...");

    let rollbackErrorCaught = false;
    try {
      await executeTransferPayment({
        source_account_id: accE.id,
        destination_account_id: accF.id,
        amount: 200.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError) {
        rollbackErrorCaught = true;
        console.log(`Caught Expected Rollback Error: "${err.message}"`);
      }
    }

    const updatedE = await getAccountById(accE.id);
    const updatedF = await getAccountById(accF.id);

    console.log(`Final Balances:   Account E = ${fmt(updatedE?.balance)} USD | Account F = ${fmt(updatedF?.balance)} EUR`);

    if (
      rollbackErrorCaught &&
      Number(updatedE?.balance) === 500.0 &&
      Number(updatedF?.balance) === 100.0
    ) {
      console.log(">>> RESULT: [PASS]\n");
      passedTests++;
    } else {
      throw new Error("Test 3 failed: Balances were not cleanly rolled back.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 4: Race Condition - Double Spend Overdraw Protection (2 Concurrent)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 4: Race Condition - Concurrent Double-Spend Attempt (2 Simultaneous Transfers)");
  console.log("--------------------------------------------------------------------------------");
  {
    // Account has $500. Two simultaneous transfers of $300 are fired at the exact same moment.
    // Total requested: $600. Without row locks, both might read $500, subtract $300, and leave -$100!
    // With SELECT ... FOR UPDATE, the second request must see $200 and be rejected.
    const accG = await createAccount({ balance: 500.0, currency: "USD" });
    const accH = await createAccount({ balance: 0.0, currency: "USD" });
    console.log(`Initial Balances: Account G = ${fmt(accG.balance)} | Account H = ${fmt(accH.balance)}`);
    console.log("Firing TWO parallel $300.00 transfers concurrently with Promise.allSettled()...");

    const [t1, t2] = await Promise.allSettled([
      executeTransferPayment({
        source_account_id: accG.id,
        destination_account_id: accH.id,
        amount: 300.0,
        currency: "USD",
      }),
      executeTransferPayment({
        source_account_id: accG.id,
        destination_account_id: accH.id,
        amount: 300.0,
        currency: "USD",
      }),
    ]);

    const finalG = await getAccountById(accG.id);
    const finalH = await getAccountById(accH.id);

    const s1 = t1.status === "fulfilled" ? "SUCCESS" : `REJECTED (${(t1 as any).reason?.message})`;
    const s2 = t2.status === "fulfilled" ? "SUCCESS" : `REJECTED (${(t2 as any).reason?.message})`;

    console.log(`Thread 1: ${s1}`);
    console.log(`Thread 2: ${s2}`);
    console.log(`Final Balances: Account G = ${fmt(finalG?.balance)} (expected: $200.00) | Account H = ${fmt(finalH?.balance)} (expected: $300.00)`);

    const successes = [t1, t2].filter((r) => r.status === "fulfilled").length;
    const rejections = [t1, t2].filter((r) => r.status === "rejected").length;

    if (
      successes === 1 &&
      rejections === 1 &&
      Number(finalG?.balance) === 200.0 &&
      Number(finalH?.balance) === 300.0
    ) {
      console.log(">>> RESULT: [PASS] - Exactly 1 transfer succeeded; account was not overspent!\n");
      passedTests++;
    } else {
      throw new Error(`Test 4 failed: Expected 1 success and 1 rejection, got ${successes} successes.`);
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 5: Race Condition - High-Concurrency Burst (10 Simultaneous Transfers)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 5: Race Condition - High-Concurrency Burst (10 Simultaneous Transfers)");
  console.log("--------------------------------------------------------------------------------");
  {
    // Source has $1,000.00.
    // 10 concurrent requests of $150.00 are fired at the exact same moment (= $1,500 total).
    // Exactly 6 transfers must succeed ($900.00 total debited).
    // Exactly 4 transfers must fail with Insufficient Balance.
    // Final balance MUST be exactly $100.00.
    const initialSource = 1000.0;
    const transferAmount = 150.0;
    const numRequests = 10;

    const sourceAcc = await createAccount({ balance: initialSource, currency: "USD" });
    const destAcc = await createAccount({ balance: 0.0, currency: "USD" });

    console.log(`Initial Source Balance:      ${fmt(sourceAcc.balance)}`);
    console.log(`Concurrent Requests Fired:   ${numRequests} transfers of ${fmt(transferAmount)} (= $1500.00 total)`);

    const promises = Array.from({ length: numRequests }, (_, i) =>
      executeTransferPayment({
        source_account_id: sourceAcc.id,
        destination_account_id: destAcc.id,
        amount: transferAmount,
        currency: "USD",
      }).then(
        (res) => ({ index: i + 1, success: true, paymentId: res.id }),
        (err) => ({ index: i + 1, success: false, error: err.message })
      )
    );

    const results = await Promise.all(promises);

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    const endSource = await getAccountById(sourceAcc.id);
    const endDest = await getAccountById(destAcc.id);

    console.log(`Transfers Succeeded:         ${successCount} (expected: 6)`);
    console.log(`Transfers Rejected:          ${failCount} (expected: 4)`);
    console.log(`Final Source Balance:        ${fmt(endSource?.balance)} (expected: $100.00)`);
    console.log(`Final Destination Balance:   ${fmt(endDest?.balance)} (expected: $900.00)`);

    // Conservation of money check: Total money in the system must remain $1000.00
    const totalMoney = Number(endSource?.balance) + Number(endDest?.balance);
    console.log(`Total Money in System:       ${fmt(totalMoney)} (expected: $1000.00 - zero drift)`);

    if (
      successCount === 6 &&
      failCount === 4 &&
      Number(endSource?.balance) === 100.0 &&
      Number(endDest?.balance) === 900.0 &&
      totalMoney === 1000.0
    ) {
      console.log(">>> RESULT: [PASS] - Strict balance conservation and zero race conditions under load!\n");
      passedTests++;
    } else {
      throw new Error(`Test 5 failed: Expected 6 successes / 4 failures / $100 remaining, but got ${successCount} successes / ${fmt(endSource?.balance)} remaining.`);
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 6: Race Condition - Bidirectional Transfer Deadlock Prevention
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 6: Race Condition - Bidirectional Transfer Deadlock Prevention (A->B & B->A)");
  console.log("--------------------------------------------------------------------------------");
  {
    // Two accounts: Alice ($500) and Bob ($500).
    // Thread 1 transfers $100 from Alice -> Bob.
    // Thread 2 transfers $100 from Bob -> Alice.
    // If locks were acquired in naive order (source first), Thread 1 locks Alice and waits for Bob;
    // Thread 2 locks Bob and waits for Alice => DEADLOCK (Postgres error 40P01)!
    // Our deterministic lock ordering (smaller UUID first) completely eliminates this cycle.
    const alice = await createAccount({ balance: 500.0, currency: "USD" });
    const bob = await createAccount({ balance: 500.0, currency: "USD" });

    console.log(`Alice (ID: ${alice.id}) Initial: ${fmt(alice.balance)}`);
    console.log(`Bob   (ID: ${bob.id}) Initial: ${fmt(bob.balance)}`);
    console.log("Firing simultaneous cross-transfers (Alice -> Bob $100) AND (Bob -> Alice $100)...");

    const [cross1, cross2] = await Promise.allSettled([
      executeTransferPayment({
        source_account_id: alice.id,
        destination_account_id: bob.id,
        amount: 100.0,
        currency: "USD",
      }),
      executeTransferPayment({
        source_account_id: bob.id,
        destination_account_id: alice.id,
        amount: 100.0,
        currency: "USD",
      }),
    ]);

    const finalAlice = await getAccountById(alice.id);
    const finalBob = await getAccountById(bob.id);

    console.log(`Transfer 1 (Alice -> Bob): ${cross1.status === "fulfilled" ? "SUCCESS" : "FAILED (" + (cross1 as any).reason?.message + ")"}`);
    console.log(`Transfer 2 (Bob -> Alice): ${cross2.status === "fulfilled" ? "SUCCESS" : "FAILED (" + (cross2 as any).reason?.message + ")"}`);
    console.log(`Alice Final Balance:       ${fmt(finalAlice?.balance)} (expected: $500.00)`);
    console.log(`Bob Final Balance:         ${fmt(finalBob?.balance)} (expected: $500.00)`);

    if (
      cross1.status === "fulfilled" &&
      cross2.status === "fulfilled" &&
      Number(finalAlice?.balance) === 500.0 &&
      Number(finalBob?.balance) === 500.0
    ) {
      console.log(">>> RESULT: [PASS] - Deterministic UUID ordering prevented deadlock; both transfers succeeded!\n");
      passedTests++;
    } else {
      throw new Error("Test 6 failed: One or both transfers failed due to deadlock or locking issue.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 7: Race Condition - Fan-In Concurrent Deposits to Single Recipient
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 7: Race Condition - Fan-In Concurrent Deposits (No Lost Updates on Destination)");
  console.log("--------------------------------------------------------------------------------");
  {
    // 5 different accounts all send $100 to the SAME destination account concurrently.
    // Verifies that concurrent UPDATE on destination account balance does not lose any updates.
    const recipient = await createAccount({ balance: 0.0, currency: "USD" });
    const senders = await Promise.all([
      createAccount({ balance: 200.0, currency: "USD" }),
      createAccount({ balance: 200.0, currency: "USD" }),
      createAccount({ balance: 200.0, currency: "USD" }),
      createAccount({ balance: 200.0, currency: "USD" }),
      createAccount({ balance: 200.0, currency: "USD" }),
    ]);

    console.log(`Recipient Initial Balance: ${fmt(recipient.balance)}`);
    console.log(`5 distinct senders firing $100.00 transfers concurrently to Recipient...`);

    const fanInResults = await Promise.allSettled(
      senders.map((sender) =>
        executeTransferPayment({
          source_account_id: sender.id,
          destination_account_id: recipient.id,
          amount: 100.0,
          currency: "USD",
        })
      )
    );

    const allSucceeded = fanInResults.every((r) => r.status === "fulfilled");
    const finalRecipient = await getAccountById(recipient.id);

    console.log(`All 5 Transfers Succeeded: ${allSucceeded}`);
    console.log(`Recipient Final Balance:   ${fmt(finalRecipient?.balance)} (expected: $500.00)`);

    if (allSucceeded && Number(finalRecipient?.balance) === 500.0) {
      console.log(">>> RESULT: [PASS] - All 5 concurrent deposits atomically aggregated without lost updates!\n");
      passedTests++;
    } else {
      throw new Error(`Test 7 failed: Recipient balance was ${fmt(finalRecipient?.balance)}, expected $500.00.`);
    }
  }

  console.log("================================================================================");
  console.log(`                  SUMMARY: ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!               `);
  console.log("================================================================================\n");

  await closeDatabaseConnection();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n [FATAL ERROR] Test suite aborted:", err);
  await closeDatabaseConnection();
  process.exit(1);
});

