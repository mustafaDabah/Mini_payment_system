// ==============================================================================
// Comprehensive Test Suite: Two-Phase Fund Reservations & Fraud Decision Flow
//
// How to run:
//   npm run test:fraud
//   OR
//   npx tsx scripts/test-fraud-flow.ts
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
  createPaymentWithReservation,
  applyFraudDecision,
  getReservationByPaymentId,
  TransferError,
} from "@payment/database";

// Helper to format currency
const fmt = (n: number | string | undefined) => `$${Number(n || 0).toFixed(2)}`;

async function main() {
  console.log("================================================================================");
  console.log("   MINI PAYMENT SYSTEM - FUND RESERVATIONS & FRAUD DECISION WORKFLOW TESTS      ");
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
  const totalTests = 10;

  // ----------------------------------------------------------------------------
  // TEST 1: Phase 1 Fund Reservation (Happy Path)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 1: Phase 1 Fund Reservation - Hold Placed, Balances Untouched");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 200.0, currency: "USD" });
    const key = crypto.randomUUID();

    console.log(`Initial: Source = ${fmt(accA.balance)} (reserved: ${fmt(accA.reserved_balance)}) | Dest = ${fmt(accB.balance)}`);
    console.log("Requesting $300.00 payment with fund reservation...");

    const { payment, reservation } = await createPaymentWithReservation({
      idempotency_key: key,
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    const updatedA = await getAccountById(accA.id);
    const updatedB = await getAccountById(accB.id);

    console.log(`Payment Status:     ${payment.status} (expected: PENDING_FRAUD_CHECK)`);
    console.log(`Reservation Status: ${reservation.status} (Amount: ${fmt(reservation.amount)})`);
    console.log(`Source Account:     Balance = ${fmt(updatedA?.balance)} (expected: $1000.00) | Reserved = ${fmt(updatedA?.reserved_balance)} (expected: $300.00)`);
    console.log(`Dest Account:       Balance = ${fmt(updatedB?.balance)} (expected: $200.00) | Reserved = ${fmt(updatedB?.reserved_balance)} (expected: $0.00)`);

    if (
      payment.status === "PENDING_FRAUD_CHECK" &&
      reservation.status === "ACTIVE" &&
      Number(updatedA?.balance) === 1000.0 &&
      Number(updatedA?.reserved_balance) === 300.0 &&
      Number(updatedB?.balance) === 200.0 &&
      Number(updatedB?.reserved_balance) === 0.0
    ) {
      console.log(">>> RESULT: [PASS] - Funds held in reserved_balance; destination balance untouched!\n");
      passedTests++;
    } else {
      throw new Error("Test 1 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 2: Insufficient Available Balance Rejection
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 2: Insufficient Available Balance Rejection");
  console.log("--------------------------------------------------------------------------------");
  {
    const accC = await createAccount({ balance: 500.0, currency: "USD" });
    const accD = await createAccount({ balance: 0.0, currency: "USD" });

    // Pre-reserve $400.00 leaving only $100.00 available
    await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accC.id,
      destination_account_id: accD.id,
      amount: 400.0,
      currency: "USD",
    });

    const intermediateC = await getAccountById(accC.id);
    console.log(`Source state: Balance = ${fmt(intermediateC?.balance)}, Reserved = ${fmt(intermediateC?.reserved_balance)} (Available = $100.00)`);
    console.log("Attempting to reserve $200.00 (which exceeds available $100.00)...");

    let errorCaught = false;
    try {
      await createPaymentWithReservation({
        idempotency_key: crypto.randomUUID(),
        source_account_id: accC.id,
        destination_account_id: accD.id,
        amount: 200.0,
        currency: "USD",
      });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 400) {
        errorCaught = true;
        console.log(`Caught Expected Error: "${err.message}"`);
      }
    }

    const finalC = await getAccountById(accC.id);
    if (errorCaught && Number(finalC?.reserved_balance) === 400.0) {
      console.log(">>> RESULT: [PASS] - Correctly rejected; reserved_balance was not exceeded.\n");
      passedTests++;
    } else {
      throw new Error("Test 2 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 3: Concurrent Race Condition - Overdraw Prevention on Available Funds
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 3: Concurrent Race Condition - Overdraw Prevention on Available Balance");
  console.log("--------------------------------------------------------------------------------");
  {
    // Source has $500.00. 5 parallel reservations of $200.00 are fired (= $1000.00 total).
    // Exactly 2 must succeed ($400.00 reserved). Exactly 3 must fail.
    const sourceAcc = await createAccount({ balance: 500.0, currency: "USD" });
    const destAcc = await createAccount({ balance: 0.0, currency: "USD" });

    console.log(`Initial Balance: ${fmt(sourceAcc.balance)}`);
    console.log("Firing 5 concurrent reservation requests of $200.00 each...");

    const promises = Array.from({ length: 5 }, () =>
      createPaymentWithReservation({
        idempotency_key: crypto.randomUUID(),
        source_account_id: sourceAcc.id,
        destination_account_id: destAcc.id,
        amount: 200.0,
        currency: "USD",
      }).then(
        (res) => ({ success: true, id: res.payment.id }),
        (err) => ({ success: false, error: err.message })
      )
    );

    const results = await Promise.all(promises);
    const endSource = await getAccountById(sourceAcc.id);

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`Reservations Succeeded: ${successCount} (expected: 2)`);
    console.log(`Reservations Rejected:  ${failCount} (expected: 3)`);
    console.log(`Final Reserved Balance: ${fmt(endSource?.reserved_balance)} (expected: $400.00)`);
    console.log(`Final Ledger Balance:   ${fmt(endSource?.balance)} (expected: $500.00)`);

    if (
      successCount === 2 &&
      failCount === 3 &&
      Number(endSource?.reserved_balance) === 400.0 &&
      Number(endSource?.balance) === 500.0
    ) {
      console.log(">>> RESULT: [PASS] - Row locks prevented concurrent over-reservation!\n");
      passedTests++;
    } else {
      throw new Error("Test 3 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 4: Fraud APPROVED Flow - Transfer Settlement
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 4: Fraud APPROVED Flow - Balance Settlement & Hold Consumption");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 200.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    console.log(`Payment created: ${payment.id} (status: ${payment.status})`);
    console.log("Applying fraud decision: APPROVED...");

    const decisionResult = await applyFraudDecision({
      paymentId: payment.id,
      decision: "APPROVED",
      reason: "Clean user history and zero velocity flags",
    });

    const finalA = await getAccountById(accA.id);
    const finalB = await getAccountById(accB.id);
    const reservation = await getReservationByPaymentId(payment.id);

    console.log(`Final Payment Status:     ${decisionResult.payment.status} (expected: COMPLETED)`);
    console.log(`Final Reservation Status: ${reservation?.status} (expected: CONSUMED)`);
    console.log(`Source Account Final:     Balance = ${fmt(finalA?.balance)} (expected: $700.00) | Reserved = ${fmt(finalA?.reserved_balance)} (expected: $0.00)`);
    console.log(`Dest Account Final:       Balance = ${fmt(finalB?.balance)} (expected: $500.00) | Reserved = ${fmt(finalB?.reserved_balance)} (expected: $0.00)`);

    const totalSystemMoney = Number(finalA?.balance) + Number(finalB?.balance);
    console.log(`Total Money in System:    ${fmt(totalSystemMoney)} (expected: $1200.00)`);

    if (
      decisionResult.payment.status === "COMPLETED" &&
      reservation?.status === "CONSUMED" &&
      Number(finalA?.balance) === 700.0 &&
      Number(finalA?.reserved_balance) === 0.0 &&
      Number(finalB?.balance) === 500.0 &&
      totalSystemMoney === 1200.0
    ) {
      console.log(">>> RESULT: [PASS] - Transfer finalized; reservation consumed; money strictly conserved!\n");
      passedTests++;
    } else {
      throw new Error("Test 4 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 5: Fraud REJECTED Flow - Fund Release
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 5: Fraud REJECTED Flow - Fund Hold Release");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 800.0, currency: "USD" });
    const accB = await createAccount({ balance: 100.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 400.0,
      currency: "USD",
    });

    console.log(`Payment created: ${payment.id} (status: ${payment.status})`);
    console.log("Applying fraud decision: REJECTED (velocity alert)...");

    const decisionResult = await applyFraudDecision({
      paymentId: payment.id,
      decision: "REJECTED",
      reason: "Exceeded velocity limit: 5 transactions within 60 seconds",
    });

    const finalA = await getAccountById(accA.id);
    const finalB = await getAccountById(accB.id);
    const reservation = await getReservationByPaymentId(payment.id);

    console.log(`Final Payment Status:     ${decisionResult.payment.status} (expected: FRAUD_REJECTED)`);
    console.log(`Final Reservation Status: ${reservation?.status} (expected: RELEASED)`);
    console.log(`Source Account Final:     Balance = ${fmt(finalA?.balance)} (expected: $800.00) | Reserved = ${fmt(finalA?.reserved_balance)} (expected: $0.00)`);
    console.log(`Dest Account Final:       Balance = ${fmt(finalB?.balance)} (expected: $100.00) | Reserved = ${fmt(finalB?.reserved_balance)} (expected: $0.00)`);

    if (
      decisionResult.payment.status === "FRAUD_REJECTED" &&
      reservation?.status === "RELEASED" &&
      Number(finalA?.balance) === 800.0 &&
      Number(finalA?.reserved_balance) === 0.0 &&
      Number(finalB?.balance) === 100.0
    ) {
      console.log(">>> RESULT: [PASS] - Hold released back to available balance; destination got nothing!\n");
      passedTests++;
    } else {
      throw new Error("Test 5 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 6: Fraud REVIEW Flow & Subsequent Approval
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 6: Fraud REVIEW Flow & Subsequent Approval");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 600.0, currency: "USD" });
    const accB = await createAccount({ balance: 50.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 250.0,
      currency: "USD",
    });

    console.log("Step 1: Applying fraud decision: REVIEW...");
    const reviewResult = await applyFraudDecision({
      paymentId: payment.id,
      decision: "REVIEW",
      reason: "Suspicious geolocation, flagged for manual compliance review",
    });

    const midA = await getAccountById(accA.id);
    const midRes = await getReservationByPaymentId(payment.id);

    console.log(`Intermediate Status: Payment = ${reviewResult.payment.status} | Reservation = ${midRes?.status}`);
    console.log(`Intermediate Source: Reserved = ${fmt(midA?.reserved_balance)} (expected: $250.00)`);

    const reviewStateValid =
      reviewResult.payment.status === "UNDER_REVIEW" &&
      midRes?.status === "ACTIVE" &&
      Number(midA?.reserved_balance) === 250.0;

    console.log("Step 2: Compliance officer approves payment -> APPROVED...");
    const approvalResult = await applyFraudDecision({
      paymentId: payment.id,
      decision: "APPROVED",
      reason: "Identity confirmed via 2FA document check",
    });

    const finalA = await getAccountById(accA.id);
    const finalB = await getAccountById(accB.id);
    const finalRes = await getReservationByPaymentId(payment.id);

    console.log(`Final Payment Status: ${approvalResult.payment.status} (expected: COMPLETED)`);
    console.log(`Final Balances:       Source = ${fmt(finalA?.balance)} (expected: $350.00) | Dest = ${fmt(finalB?.balance)} (expected: $300.00)`);

    if (
      reviewStateValid &&
      approvalResult.payment.status === "COMPLETED" &&
      finalRes?.status === "CONSUMED" &&
      Number(finalA?.balance) === 350.0 &&
      Number(finalA?.reserved_balance) === 0.0 &&
      Number(finalB?.balance) === 300.0
    ) {
      console.log(">>> RESULT: [PASS] - Multi-stage transition UNDER_REVIEW -> COMPLETED succeeded!\n");
      passedTests++;
    } else {
      throw new Error("Test 6 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 7: Fraud REVIEW Flow & Subsequent Rejection
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 7: Fraud REVIEW Flow & Subsequent Rejection");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 500.0, currency: "USD" });
    const accB = await createAccount({ balance: 0.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 150.0,
      currency: "USD",
    });

    await applyFraudDecision({
      paymentId: payment.id,
      decision: "REVIEW",
    });

    console.log("Compliance rejects payment from UNDER_REVIEW -> REJECTED...");
    const rejectResult = await applyFraudDecision({
      paymentId: payment.id,
      decision: "REJECTED",
      reason: "Failed verification",
    });

    const finalA = await getAccountById(accA.id);
    const finalRes = await getReservationByPaymentId(payment.id);

    console.log(`Final Status: Payment = ${rejectResult.payment.status} | Reservation = ${finalRes?.status}`);
    console.log(`Source Balances: Balance = ${fmt(finalA?.balance)} (expected: $500.00) | Reserved = ${fmt(finalA?.reserved_balance)} (expected: $0.00)`);

    if (
      rejectResult.payment.status === "FRAUD_REJECTED" &&
      finalRes?.status === "RELEASED" &&
      Number(finalA?.balance) === 500.0 &&
      Number(finalA?.reserved_balance) === 0.0
    ) {
      console.log(">>> RESULT: [PASS] - Multi-stage transition UNDER_REVIEW -> FRAUD_REJECTED succeeded!\n");
      passedTests++;
    } else {
      throw new Error("Test 7 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 8: Idempotent Decision Delivery (Duplicate APPROVED Decisions)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 8: Idempotent Decision Delivery (Duplicate APPROVED Deliveries)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 500.0, currency: "USD" });
    const accB = await createAccount({ balance: 100.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 200.0,
      currency: "USD",
    });

    console.log("First delivery: APPROVED...");
    await applyFraudDecision({ paymentId: payment.id, decision: "APPROVED" });

    const firstA = await getAccountById(accA.id);
    const firstB = await getAccountById(accB.id);

    console.log("Second delivery (network replay): APPROVED...");
    const replayResult = await applyFraudDecision({ paymentId: payment.id, decision: "APPROVED" });

    const replayA = await getAccountById(accA.id);
    const replayB = await getAccountById(accB.id);

    console.log(`Replayed Payment Status: ${replayResult.payment.status}`);
    console.log(`Balances after replay:   Source = ${fmt(replayA?.balance)} (still $300.00) | Dest = ${fmt(replayB?.balance)} (still $300.00)`);

    if (
      replayResult.payment.status === "COMPLETED" &&
      Number(firstA?.balance) === 300.0 &&
      Number(firstB?.balance) === 300.0 &&
      Number(replayA?.balance) === 300.0 &&
      Number(replayB?.balance) === 300.0
    ) {
      console.log(">>> RESULT: [PASS] - Duplicate APPROVED was an idempotent no-op (no double debit/credit)!\n");
      passedTests++;
    } else {
      throw new Error("Test 8 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 9: Illegal Transition Rejection (REJECTED after APPROVED)
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 9: Illegal Transition Rejection (REJECTED after COMPLETED)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 400.0, currency: "USD" });
    const accB = await createAccount({ balance: 0.0, currency: "USD" });

    const { payment } = await createPaymentWithReservation({
      idempotency_key: crypto.randomUUID(),
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 100.0,
      currency: "USD",
    });

    await applyFraudDecision({ paymentId: payment.id, decision: "APPROVED" });

    console.log("Attempting to apply REJECTED on an already COMPLETED payment...");
    let conflictCaught = false;

    try {
      await applyFraudDecision({ paymentId: payment.id, decision: "REJECTED" });
    } catch (err: any) {
      if (err instanceof TransferError && err.statusCode === 409) {
        conflictCaught = true;
        console.log(`Caught Expected 409 Conflict: "${err.message}"`);
      }
    }

    if (conflictCaught) {
      console.log(">>> RESULT: [PASS] - Illegal state transition correctly blocked with 409 Conflict!\n");
      passedTests++;
    } else {
      throw new Error("Test 9 failed.");
    }
  }

  // ----------------------------------------------------------------------------
  // TEST 10: Reservation Idempotency on Payment Creation
  // ----------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("TEST 10: Reservation Idempotency on Payment Creation (No Double Reservation)");
  console.log("--------------------------------------------------------------------------------");
  {
    const accA = await createAccount({ balance: 1000.0, currency: "USD" });
    const accB = await createAccount({ balance: 0.0, currency: "USD" });
    const key = "idemp-res-" + crypto.randomUUID();

    console.log(`Initial: Source = ${fmt(accA.balance)}`);
    console.log(`First request with key "${key}" ($300.00)...`);

    const res1 = await createPaymentWithReservation({
      idempotency_key: key,
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    const midA = await getAccountById(accA.id);
    console.log(`After Request 1: Source Reserved = ${fmt(midA?.reserved_balance)} (expected: $300.00)`);

    console.log(`Replaying identical request with key "${key}" ($300.00)...`);
    const res2 = await createPaymentWithReservation({
      idempotency_key: key,
      source_account_id: accA.id,
      destination_account_id: accB.id,
      amount: 300.0,
      currency: "USD",
    });

    const finalA = await getAccountById(accA.id);
    console.log(`After Request 2: Source Reserved = ${fmt(finalA?.reserved_balance)} (still: $300.00)`);

    if (
      res1.payment.id === res2.payment.id &&
      res1.reservation.id === res2.reservation.id &&
      Number(finalA?.reserved_balance) === 300.0
    ) {
      console.log(">>> RESULT: [PASS] - Retrying with same key returned existing payment without double-reserving funds!\n");
      passedTests++;
    } else {
      throw new Error("Test 10 failed.");
    }
  }

  console.log("================================================================================");
  console.log(`           SUMMARY: ALL ${passedTests}/${totalTests} FRAUD TESTS PASSED SUCCESSFULLY!`);
  console.log("================================================================================\n");

  await closeDatabaseConnection();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n [FATAL ERROR] Test suite aborted:", err);
  await closeDatabaseConnection();
  process.exit(1);
});

