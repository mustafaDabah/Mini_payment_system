// ==============================================================================
// Express API Server - Mini Payment System
// ==============================================================================

import dotenv from "dotenv";
import path from "path";

// Load environment variables from the project root .env file
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import express, { Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "./docs/openapi";
import {
  initDatabase,
  checkDatabaseConnection,
  closeDatabaseConnection,
  createPayment,
  executeTransferPayment,
  TransferError,
  getPaymentById,
  listPayments,
  createAccount,
  getAccountById,
  PaymentCurrency,
} from "@payment/database";

const app = express();
const PORT = Number(process.env.API_PORT) || 3000;

app.use(express.json());

// ------------------------------------------------------------------------------
// Swagger / OpenAPI Documentation
// ------------------------------------------------------------------------------
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get("/docs.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(openApiSpec);
});

const SUPPORTED_CURRENCIES: PaymentCurrency[] = ["USD", "EUR", "GBP"];

// ------------------------------------------------------------------------------
// Health Endpoints
// ------------------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
  });
});

app.get("/health/db", async (_req: Request, res: Response) => {
  const dbStatus = await checkDatabaseConnection();

  if (dbStatus.connected) {
    return res.status(200).json({
      status: "ok",
      database: "connected",
      timestamp: dbStatus.timestamp,
    });
  }

  return res.status(503).json({
    status: "error",
    database: "disconnected",
    error: dbStatus.error,
  });
});

// ------------------------------------------------------------------------------
// Account Endpoints (Helper to create accounts for payment testing)
// ------------------------------------------------------------------------------

/**
 * POST /accounts
 * Creates a new account with an initial balance and currency.
 */
app.post("/accounts", async (req: Request, res: Response) => {
  try {
    const { balance, currency } = req.body;

    if (currency && !SUPPORTED_CURRENCIES.includes(currency)) {
      return res.status(400).json({
        error: `Unsupported currency. Allowed: ${SUPPORTED_CURRENCIES.join(", ")}`,
      });
    }

    if (balance !== undefined && (isNaN(Number(balance)) || Number(balance) < 0)) {
      return res.status(400).json({
        error: "Balance must be a positive number",
      });
    }

    const account = await createAccount({
      balance: balance !== undefined ? Number(balance) : 0,
      currency: currency || "USD",
    });

    return res.status(201).json(account);
  } catch (error) {
    console.error("[api] Error creating account:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /accounts/:id
 * Fetches an account by ID.
 */
app.get("/accounts/:id", async (req: Request, res: Response) => {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    return res.status(200).json(account);
  } catch (error) {
    console.error("[api] Error retrieving account:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------------------------
// Payment Endpoints
// ------------------------------------------------------------------------------

/**
 * POST /payments
 * Creates a new payment between source and destination accounts.
 */
app.post("/payments", async (req: Request, res: Response) => {
  try {
    const {
      source_account_id,
      destination_account_id,
      amount,
      currency = "USD",
    } = req.body;

    // 1. Validate required fields
    if (!source_account_id || typeof source_account_id !== "string") {
      return res.status(400).json({ error: "source_account_id is required" });
    }

    if (!destination_account_id || typeof destination_account_id !== "string") {
      return res.status(400).json({ error: "destination_account_id is required" });
    }

    if (source_account_id === destination_account_id) {
      return res.status(400).json({
        error: "source_account_id and destination_account_id cannot be the same",
      });
    }

    const numericAmount = Number(amount);
    if (!amount || isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "amount must be a positive number greater than zero",
      });
    }

    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return res.status(400).json({
        error: `Unsupported currency '${currency}'. Allowed: ${SUPPORTED_CURRENCIES.join(", ")}`,
      });
    }

    // 2. Verify both accounts exist in database
    const [sourceAccount, destinationAccount] = await Promise.all([
      getAccountById(source_account_id),
      getAccountById(destination_account_id),
    ]);

    if (!sourceAccount) {
      return res.status(404).json({
        error: `Source account '${source_account_id}' does not exist`,
      });
    }

    if (!destinationAccount) {
      return res.status(404).json({
        error: `Destination account '${destination_account_id}' does not exist`,
      });
    }

    // 2. Execute atomic transfer transaction (deterministic locking, validations, balance mutations, COMPLETED status)
    const payment = await executeTransferPayment({
      source_account_id,
      destination_account_id,
      amount: numericAmount,
      currency,
      status: "PENDING",
    });

    console.log(`[api] Payment created: ${payment.id} (${payment.amount} ${payment.currency})`);
    console.log(`[api] Payment completed atomically: ${payment.id} (${payment.amount} ${payment.currency})`);
    return res.status(201).json(payment);
  } catch (error) {
    if (error instanceof TransferError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("[api] Error creating payment:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /payments/:id
 * Fetches a single payment by UUID.
 */
app.get("/payments/:id", async (req: Request, res: Response) => {
  try {
    const payment = await getPaymentById(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    return res.status(200).json(payment);
  } catch (error) {
    console.error("[api] Error retrieving payment:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /payments
 * Lists recent payments.
 */
app.get("/payments", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const payments = await listPayments(limit, offset);
    return res.status(200).json({
      data: payments,
      limit,
      offset,
    });
  } catch (error) {
    console.error("[api] Error listing payments:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------------------------------------------------------
// Server Lifecycle & Graceful Shutdown
// ------------------------------------------------------------------------------

const server = app.listen(PORT, async () => {
  console.log(`[api] Express server running at http://localhost:${PORT}`);
  console.log(`[api] Swagger UI docs: http://localhost:${PORT}/docs`);
  console.log(`[api] Health endpoint: http://localhost:${PORT}/health`);
  console.log(`[api] Payments endpoint: http://localhost:${PORT}/payments`);

  // Verify and initialize DB tables
  const dbCheck = await checkDatabaseConnection();
  if (dbCheck.connected) {
    console.log(`[api] Connected to PostgreSQL (Time: ${dbCheck.timestamp})`);
    try {
      await initDatabase();
      console.log("[api] Database tables (accounts, payments) initialized successfully.");
    } catch (initErr) {
      console.error("[api] Failed to initialize database tables:", initErr);
    }
  } else {
    console.warn(`[api] Warning: Could not connect to PostgreSQL: ${dbCheck.error}`);
    console.warn("[api] Ensure Docker PostgreSQL container is running (`docker compose up -d postgres`).");
  }
});

async function handleShutdown(signal: string) {
  console.log(`\n[api] Received ${signal}. Starting graceful shutdown...`);

  server.close(async (serverErr) => {
    if (serverErr) {
      console.error("[api] Error closing HTTP server:", serverErr);
    } else {
      console.log("[api] HTTP server closed.");
    }

    try {
      await closeDatabaseConnection();
      console.log("[api] PostgreSQL connections closed.");
      process.exit(0);
    } catch (dbErr) {
      console.error("[api] Error closing database connection pool:", dbErr);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error("[api] Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
