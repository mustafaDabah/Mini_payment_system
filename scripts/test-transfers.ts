// ==============================================================================
// Comprehensive Test Suite: Atomic Transfers & Race Condition Verification
// Comprehensive Test Suite: Atomic Transfers, Race Conditions & Idempotency
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
import crypto from "crypto";

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
  console.log("    MINI PAYMENT SYSTEM - ATOMIC TRANSFERS, CONCURRENCY & IDEMPOTENCY TESTS     ");
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
  const totalTests = 11;

  // ----------------------------------------------------------------------------
  // TEST 1: Baseline Happy Path Transfer ($300.00)
  // TEST 1: Baseline Single Transfer ($300.00)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 1: Baseline Single Transfer ($300.00)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 200.0, currency: "USD" });
    console.log(`Initial Balances: Account A = ${fmt(accA.balance)} | Account B = ${fmt(accB.balance)}`);
    const key = crypto.randomUUID();

    const payment = await executeTransferPayment({
      idempotency_key: key,
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
      payment.idempotency_key === key &&
      Number(updatedA?.balance) === 700.0 &&
      Number(updatedB?.balance) === 500.0
    ) {
      console.log(`Payment Status: ${payment.status} | Idempotency Key: ${payment.idempotency_key}`);
      console.log(`Updated Balances: A = ${fmt(updatedA?.balance)} | B = ${fmt(updatedB?.balance)}`);
      console.log(">>> RESULT: [PASS]\n");
      passedTests++;
    } else {
      throw new Error("Test 1 failed: Balances or status did not match expected values.");
      throw new Error("Test 1 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 2: Insufficient Balance Rejection
  // TEST 2: Insufficient Balance Rejection (Zero State Leakage)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 2: Insufficient Balance Rejection (Zero State Leakage)");
  console.log("TEST 2: Insufficient Balance Rejection");
  console.log("--------------------------------------------------------------------------------");
  {
    const accC = await createAccount({ balance: 100.0, currency: "USD" });
    const accD = await createAccount({ balance: 50.0, currency: "USD" });
    console.log(`Initial Balances: Account C = ${fmt(accC.balance)} | Account D = ${fmt(accD.balance)}`);
    console.log("Attempting transfer of $300.00 (which exceeds $100.00 balance)...");
    let expectedError = false;

    let expectedErrorCaught = false;
    try {
      await executeTransferPayment({
        idempotency_key: crypto.randomUUID(),
        source_account_id: accC.id,
        destination_account_id: accD.id,
        amount: 300.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 400) {
        expectedErrorCaught = true;
        expectedError = true;
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
    if (expectedError && Number(updatedC?.balance) === 100.0 && Number(updatedD?.balance) === 50.0) {
      console.log(">>> RESULT: [PASS]\n");
      passedTests++;
    } else {
      throw new Error("Test 2 failed: Balances were altered despite insufficient funds.");
      throw new Error("Test 2 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 3: Mid-Transaction Failure -> Clean Rollback
  // TEST 3: Bidirectional Transfer Deadlock Prevention
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 3: Mid-Transaction Failure Clean Rollback (Currency Mismatch)");
  console.log("TEST 3: Bidirectional Transfer Deadlock Prevention (A->B & B->A simultaneously)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accE = await createAccount({ balance: 500.0, currency: "USD" });
    const accF = await createAccount({ balance: 100.0, currency: "EUR" }); // Currency mismatch
    console.log(`Initial Balances: Account E = ${fmt(accE.balance)} USD | Account F = ${fmt(accF.balance)} EUR`);
    console.log("Attempting transfer with mismatching currency (USD -> EUR)...");
    const alice = await createAccount({ balance: 500.0, currency: "USD" });
    const bob = await createAccount({ balance: 500.0, currency: "USD" });

    let rollbackErrorCaught = false;
    try {
      await executeTransferPayment({
        source_account_id: accE.id,
        destination_account_id: accF.id,
        amount: 200.0,
    const [cross1, cross2] = await Promise.allSettled([
      executeTransferPayment({
        idempotency_key: crypto.randomUUID(),
        source_account_id: alice.id,
        destination_account_id: bob.id,
        amount: 100.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError) {
        rollbackErrorCaught = true;
        console.log(`Caught Expected Rollback Error: "${err.message}"`);
      }
    }
      }),
      executeTransferPayment({
        idempotency_key: crypto.randomUUID(),
        source_account_id: bob.id,
        destination_account_id: alice.id,
        amount: 100.0,
        currency: "USD",
      }),
    ]);

    const updatedE = await getAccountById(accE.id);
    const updatedF = await getAccountById(accF.id);
    const finalAlice = await getAccountById(alice.id);
    const finalBob = await getAccountById(bob.id);

    console.log(`Final Balances:   Account E = ${fmt(updatedE?.balance)} USD | Account F = ${fmt(updatedF?.balance)} EUR`);

    if (
      rollbackErrorCaught &&
      Number(updatedE?.balance) === 500.0 &&
      Number(updatedF?.balance) === 100.0
      cross1.status === "fulfilled" &&
      cross2.status === "fulfilled" &&
      Number(finalAlice?.balance) === 500.0 &&
      Number(finalBob?.balance) === 500.0
    ) {
      console.log(">>> RESULT: [PASS]\n");
      console.log(">>> RESULT: [PASS] - Deterministic UUID ordering prevented deadlock!\n");
      passedTests++;
    } else {
      throw new Error("Test 3 failed: Balances were not cleanly rolled back.");
      throw new Error("Test 3 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 4: Race Condition - Double Spend Overdraw Protection (2 Concurrent)
  // TEST 4: Concurrency Double-Spend Attempt (2 Different Keys, Same Account)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 4: Race Condition - Concurrent Double-Spend Attempt (2 Simultaneous Transfers)");
  console.log("TEST 4: Overdraw Race Condition ($500 balance, two parallel $300 transfers)");
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
        idempotency_key: crypto.randomUUID(),
        source_account_id: accG.id,
        destination_account_id: accH.id,
        amount: 300.0,
        currency: "USD",
      }),
      executeTransferPayment({
        idempotency_key: crypto.randomUUID(),
        source_account_id: accG.id,
        destination_account_id: accH.id,
        amount: 300.0,
        currency: "USD",
      }),
    ]);

    const finalG = await getAccountById(accG.id);
    const finalH = await getAccountById(accH.id);
    const successes = [t1, t2].filter((r) => r.status === "fulfilled").length;
    const rejections = [t1, t2].filter((r) => r.status === "rejected").length;

    const s1 = t1.status === "fulfilled" ? "SUCCESS" : `REJECTED (${(t1 as any).reason?.message})`;
    const s2 = t2.status === "fulfilled" ? "SUCCESS" : `REJECTED (${(t2 as any).reason?.message})`;
    if (successes === 1 && rejections === 1 && Number(finalG?.balance) === 200.0 && Number(finalH?.balance) === 300.0) {
      console.log(">>> RESULT: [PASS] - Exactly 1 transfer succeeded; account was not overspent!\n");
      passedTests++;
    } else {
      throw new Error("Test 4 failed.");
    }
  }

    console.log(`Thread 1: ${s1}`);
    console.log(`Thread 2: ${s2}`);
    console.log(`Final Balances: Account G = ${fmt(finalG?.balance)} (expected: $200.00) | Account H = ${fmt(finalH?.balance)} (expected: $300.00)`);
  // ============================================================================
  // IDEMPOTENCY TEST SUITE
  // ============================================================================

    const successes = [t1, t2].filter((r) => r.status === "fulfilled").length;
    const rejections = [t1, t2].filter((r) => r.status === "rejected").length;
  // ----------------------------------------------------------------------------
  // TEST 5: Idempotency - First Request with New Key
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 5: Idempotency - First Request with a New Key (Succeeds)");
  console.log("--------------------------------------------------------------------------------");
  const testKey = "idemp-key-" + crypto.randomUUID();
  let firstPaymentId = "";
  let idempAccAId = "";
  let idempAccBId = "";

  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 100.0, currency: "USD" });
    idempAccAId = accA.id;
    idempAccBId = accB.id;

    console.log(`Initial: Account A = ${fmt(accA.balance)} | Account B = ${fmt(accB.balance)}`);
    console.log(`Submitting Transfer with Idempotency Key: "${testKey}"`);

    const payment = await executeTransferPayment({
      idempotency_key: testKey,
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    firstPaymentId = payment.id;
    const updatedA = await getAccountById(accA.id);
    const updatedB = await getAccountById(accB.id);

    console.log(`Created Payment ID: ${payment.id} (status: ${payment.status}, key: ${payment.idempotency_key})`);
    console.log(`Balances after first transfer: A = ${fmt(updatedA?.balance)} | B = ${fmt(updatedB?.balance)}`);

    if (
      successes === 1 &&
      rejections === 1 &&
      Number(finalG?.balance) === 200.0 &&
      Number(finalH?.balance) === 300.0
      payment.status === "COMPLETED" &&
      payment.idempotency_key === testKey &&
      Number(updatedA?.balance) === 700.0 &&
      Number(updatedB?.balance) === 400.0
    ) {
      console.log(">>> RESULT: [PASS] - Exactly 1 transfer succeeded; account was not overspent!\n");
      console.log(">>> RESULT: [PASS] - First request succeeded.\n");
      passedTests++;
    } else {
      throw new Error(`Test 4 failed: Expected 1 success and 1 rejection, got ${successes} successes.`);
      throw new Error("Test 5 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 5: Race Condition - High-Concurrency Burst (10 Simultaneous Transfers)
  // TEST 6: Idempotency - Replay Same Key with Exactly Same Parameters
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 5: Race Condition - High-Concurrency Burst (10 Simultaneous Transfers)");
  console.log("TEST 6: Idempotency - Replay Same Key + Exactly Same Parameters (No Double Transfer)");
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
    console.log(`Resubmitting Transfer with SAME Key: "${testKey}" and SAME parameters ($300.00)...`);

    const sourceAcc = await createAccount({ balance: initialSource, currency: "USD" });
    const destAcc = await createAccount({ balance: 0.0, currency: "USD" });
    const replayedPayment = await executeTransferPayment({
      idempotency_key: testKey,
      source_account_id: idempAccAId,
      destination_account_id: idempAccBId,
      amount: 300.0,
      currency: "USD",
    });

    console.log(`Initial Source Balance:      ${fmt(sourceAcc.balance)}`);
    console.log(`Concurrent Requests Fired:   ${numRequests} transfers of ${fmt(transferAmount)} (= $1500.00 total)`);
    const currentA = await getAccountById(idempAccAId);
    const currentB = await getAccountById(idempAccBId);

    const promises = Array.from({ length: numRequests }, (_, i) =>
      executeTransferPayment({
        source_account_id: sourceAcc.id,
        destination_account_id: destAcc.id,
        amount: transferAmount,
    console.log(`Returned Payment ID: ${replayedPayment.id} (Matches original: ${replayedPayment.id === firstPaymentId})`);
    console.log(`Current Balances:    A = ${fmt(currentA?.balance)} (still $700.00) | B = ${fmt(currentB?.balance)} (still $400.00)`);

    if (
      replayedPayment.id === firstPaymentId &&
      Number(currentA?.balance) === 700.0 &&
      Number(currentB?.balance) === 400.0
    ) {
      console.log(">>> RESULT: [PASS] - Returned existing payment; NO duplicate funds were transferred!\n");
      passedTests++;
    } else {
      throw new Error("Test 6 failed: Payment was re-executed or balances changed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 7: Idempotency Conflict - Same Key + Different Amount
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 7: Idempotency Conflict - Same Key + Different Amount (Rejected with 409)");
  console.log("--------------------------------------------------------------------------------");
  {
    console.log(`Submitting Transfer with SAME Key "${testKey}" but DIFFERENT amount ($500.00 instead of $300.00)...`);
    let conflictCaught = false;

    try {
      await executeTransferPayment({
        idempotency_key: testKey,
        source_account_id: idempAccAId,
        destination_account_id: idempAccBId,
        amount: 500.0, // Different amount!
        currency: "USD",
      }).then(
        (res) => ({ index: i + 1, success: true, paymentId: res.id }),
        (err) => ({ index: i + 1, success: false, error: err.message })
      )
    );
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 409) {
        conflictCaught = true;
        console.log(`Caught Expected 409 Conflict: "${err.message}"`);
      }
    }

    const results = await Promise.all(promises);
    const currentA = await getAccountById(idempAccAId);
    const currentB = await getAccountById(idempAccBId);

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;
    if (conflictCaught && Number(currentA?.balance) === 700.0 && Number(currentB?.balance) === 400.0) {
      console.log(">>> RESULT: [PASS] - Request correctly rejected with 409 Conflict; balances unchanged.\n");
      passedTests++;
    } else {
      throw new Error("Test 7 failed: Conflicting amount was not rejected with 409.");
    }
  }

    const endSource = await getAccountById(sourceAcc.id);
    const endDest = await getAccountById(destAcc.id);
  // ----------------------------------------------------------------------------
  // TEST 8: Idempotency Conflict - Same Key + Different Destination
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 8: Idempotency Conflict - Same Key + Different Destination Account (409)");
  console.log("--------------------------------------------------------------------------------");
  {
    const differentDest = await createAccount({ balance: 0.0, currency: "USD" });
    console.log(`Submitting Transfer with SAME Key "${testKey}" but DIFFERENT destination (${differentDest.id})...`);
    let conflictCaught = false;

    console.log(`Transfers Succeeded:         ${successCount} (expected: 6)`);
    console.log(`Transfers Rejected:          ${failCount} (expected: 4)`);
    console.log(`Final Source Balance:        ${fmt(endSource?.balance)} (expected: $100.00)`);
    console.log(`Final Destination Balance:   ${fmt(endDest?.balance)} (expected: $900.00)`);
    try {
      await executeTransferPayment({
        idempotency_key: testKey,
        source_account_id: idempAccAId,
        destination_account_id: differentDest.id, // Different destination!
        amount: 300.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 409) {
        conflictCaught = true;
        console.log(`Caught Expected 409 Conflict: "${err.message}"`);
      }
    }

    // Conservation of money check: Total money in the system must remain $1000.00
    const totalMoney = Number(endSource?.balance) + Number(endDest?.balance);
    console.log(`Total Money in System:       ${fmt(totalMoney)} (expected: $1000.00 - zero drift)`);
    const currentA = await getAccountById(idempAccAId);
    const currentDifferentDest = await getAccountById(differentDest.id);

    if (
      successCount === 6 &&
      failCount === 4 &&
      Number(endSource?.balance) === 100.0 &&
      Number(endDest?.balance) === 900.0 &&
      totalMoney === 1000.0
    ) {
      console.log(">>> RESULT: [PASS] - Strict balance conservation and zero race conditions under load!\n");
    if (conflictCaught && Number(currentA?.balance) === 700.0 && Number(currentDifferentDest?.balance) === 0.0) {
      console.log(">>> RESULT: [PASS] - Request correctly rejected with 409 Conflict; balances unchanged.\n");
      passedTests++;
    } else {
      throw new Error(`Test 5 failed: Expected 6 successes / 4 failures / $100 remaining, but got ${successCount} successes / ${fmt(endSource?.balance)} remaining.`);
      throw new Error("Test 8 failed: Conflicting destination was not rejected with 409.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 6: Race Condition - Bidirectional Transfer Deadlock Prevention
  // TEST 9: Idempotency Conflict - Same Key + Different Currency
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 6: Race Condition - Bidirectional Transfer Deadlock Prevention (A->B & B->A)");
  console.log("TEST 9: Idempotency Conflict - Same Key + Different Currency (409)");
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
    console.log(`Submitting Transfer with SAME Key "${testKey}" but DIFFERENT currency ("EUR" instead of "USD")...`);
    let conflictCaught = false;

    console.log(`Alice (ID: ${alice.id}) Initial: ${fmt(alice.balance)}`);
    console.log(`Bob   (ID: ${bob.id}) Initial: ${fmt(bob.balance)}`);
    console.log("Firing simultaneous cross-transfers (Alice -> Bob $100) AND (Bob -> Alice $100)...");
    try {
      await executeTransferPayment({
        idempotency_key: testKey,
        source_account_id: idempAccAId,
        destination_account_id: idempAccBId,
        amount: 300.0,
        currency: "EUR", // Different currency!
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 409) {
        conflictCaught = true;
        console.log(`Caught Expected 409 Conflict: "${err.message}"`);
      }
    }

    const [cross1, cross2] = await Promise.allSettled([
    const currentA = await getAccountById(idempAccAId);
    const currentB = await getAccountById(idempAccBId);

    if (conflictCaught && Number(currentA?.balance) === 700.0 && Number(currentB?.balance) === 400.0) {
      console.log(">>> RESULT: [PASS] - Request correctly rejected with 409 Conflict; balances unchanged.\n");
      passedTests++;
    } else {
      throw new Error("Test 9 failed: Conflicting currency was not rejected with 409.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 10: Concurrency Race - Two Simultaneous Requests with SAME Idempotency Key
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 10: Concurrency Race - Two Identical Requests with SAME Idempotency Key");
  console.log("--------------------------------------------------------------------------------");
  {
    const raceKey = "race-key-" + crypto.randomUUID();
    const raceSource = await createAccount({ balance: 500.0, currency: "USD" });
    const raceDest = await createAccount({ balance: 0.0, currency: "USD" });

    console.log(`Initial Balances: Source = ${fmt(raceSource.balance)} | Dest = ${fmt(raceDest.balance)}`);
    console.log(`Firing TWO concurrent requests with the SAME Idempotency Key "${raceKey}" for $300.00...`);

    const [req1, req2] = await Promise.allSettled([
      executeTransferPayment({
        source_account_id: alice.id,
        destination_account_id: bob.id,
        amount: 100.0,
        idempotency_key: raceKey,
        source_account_id: raceSource.id,
        destination_account_id: raceDest.id,
        amount: 300.0,
        currency: "USD",
      }),
      executeTransferPayment({
        source_account_id: bob.id,
        destination_account_id: alice.id,
        amount: 100.0,
        idempotency_key: raceKey,
        source_account_id: raceSource.id,
        destination_account_id: raceDest.id,
        amount: 300.0,
        currency: "USD",
      }),
    ]);

    const finalAlice = await getAccountById(alice.id);
    const finalBob = await getAccountById(bob.id);
    const endSource = await getAccountById(raceSource.id);
    const endDest = await getAccountById(raceDest.id);

    console.log(`Transfer 1 (Alice -> Bob): ${cross1.status === "fulfilled" ? "SUCCESS" : "FAILED (" + (cross1 as any).reason?.message + ")"}`);
    console.log(`Transfer 2 (Bob -> Alice): ${cross2.status === "fulfilled" ? "SUCCESS" : "FAILED (" + (cross2 as any).reason?.message + ")"}`);
    console.log(`Alice Final Balance:       ${fmt(finalAlice?.balance)} (expected: $500.00)`);
    console.log(`Bob Final Balance:         ${fmt(finalBob?.balance)} (expected: $500.00)`);
    console.log(`Request 1 Status: ${req1.status === "fulfilled" ? "FULFILLED (Payment ID: " + req1.value.id + ")" : "REJECTED (" + (req1 as any).reason?.message + ")"}`);
    console.log(`Request 2 Status: ${req2.status === "fulfilled" ? "FULFILLED (Payment ID: " + req2.value.id + ")" : "REJECTED (" + (req2 as any).reason?.message + ")"}`);
    console.log(`Final Balances:   Source = ${fmt(endSource?.balance)} (expected: $200.00) | Dest = ${fmt(endDest?.balance)} (expected: $300.00)`);

    if (
      cross1.status === "fulfilled" &&
      cross2.status === "fulfilled" &&
      Number(finalAlice?.balance) === 500.0 &&
      Number(finalBob?.balance) === 500.0
    ) {
      console.log(">>> RESULT: [PASS] - Deterministic UUID ordering prevented deadlock; both transfers succeeded!\n");
    // Both requests must resolve cleanly to the same payment (or exactly 1 creates and 1 receives the same payment)
    const p1 = req1.status === "fulfilled" ? req1.value : null;
    const p2 = req2.status === "fulfilled" ? req2.value : null;

    const samePayment = p1 && p2 && p1.id === p2.id;
    const balancesCorrect = Number(endSource?.balance) === 200.0 && Number(endDest?.balance) === 300.0;

    if (samePayment && balancesCorrect) {
      console.log(">>> RESULT: [PASS] - Both concurrent requests returned identical payment; exactly $300 was debited once!\n");
      passedTests++;
    } else {
      throw new Error("Test 6 failed: One or both transfers failed due to deadlock or locking issue.");
      throw new Error(`Test 10 failed: Concurrent identical idempotency key requests resulted in inconsistent state.`);
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 7: Race Condition - Fan-In Concurrent Deposits to Single Recipient
  // TEST 11: Different Idempotency Keys -> Independent Payments Allowed
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 7: Race Condition - Fan-In Concurrent Deposits (No Lost Updates on Destination)");
  console.log("TEST 11: Different Idempotency Keys -> Independent Payments Allowed");
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
    const accI = await createAccount({ balance: 500.0, currency: "USD" });
    const accJ = await createAccount({ balance: 0.0, currency: "USD" });

    console.log(`Recipient Initial Balance: ${fmt(recipient.balance)}`);
    console.log(`5 distinct senders firing $100.00 transfers concurrently to Recipient...`);
    const key1 = crypto.randomUUID();
    const key2 = crypto.randomUUID();

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
    console.log(`Executing Transfer 1 with key: ${key1} ($100.00)...`);
    const p1 = await executeTransferPayment({
      idempotency_key: key1,
      source_account_id: accI.id,
      destination_account_id: accJ.id,
      amount: 100.0,
      currency: "USD",
    });

    const allSucceeded = fanInResults.every((r) => r.status === "fulfilled");
    const finalRecipient = await getAccountById(recipient.id);
    console.log(`Executing Transfer 2 with key: ${key2} ($150.00)...`);
    const p2 = await executeTransferPayment({
      idempotency_key: key2,
      source_account_id: accI.id,
      destination_account_id: accJ.id,
      amount: 150.0,
      currency: "USD",
    });

    console.log(`All 5 Transfers Succeeded: ${allSucceeded}`);
    console.log(`Recipient Final Balance:   ${fmt(finalRecipient?.balance)} (expected: $500.00)`);
    const finalI = await getAccountById(accI.id);
    const finalJ = await getAccountById(accJ.id);

    if (allSucceeded && Number(finalRecipient?.balance) === 500.0) {
      console.log(">>> RESULT: [PASS] - All 5 concurrent deposits atomically aggregated without lost updates!\n");
    console.log(`Payment 1 ID: ${p1.id} | Payment 2 ID: ${p2.id}`);
    console.log(`Final Balances: Account I = ${fmt(finalI?.balance)} (expected: $250.00) | Account J = ${fmt(finalJ?.balance)} (expected: $250.00)`);

    if (
      p1.id !== p2.id &&
      Number(finalI?.balance) === 250.0 &&
      Number(finalJ?.balance) === 250.0
    ) {
      console.log(">>> RESULT: [PASS] - Distinct idempotency keys executed independently.\n");
      passedTests++;
    } else {
      throw new Error(`Test 7 failed: Recipient balance was ${fmt(finalRecipient?.balance)}, expected $500.00.`);
      throw new Error("Test 11 failed.");
    }
  }

  console.log("================================================================================");
  console.log(`                  SUMMARY: ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!               `);
  console.log(`           SUMMARY: ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
  console.log("================================================================================\n");

  await closeDatabaseConnection();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n [FATAL ERROR] Test suite aborted:", err);
  await closeDatabaseConnection();
  process.exit(1);
});

