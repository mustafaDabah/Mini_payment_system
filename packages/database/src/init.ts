// ==============================================================================
// Standalone Database Initialization Script
// ==============================================================================

import { initDatabase, checkDatabaseConnection, closeDatabaseConnection } from "./index";

async function main() {
  console.log("[db:init] Connecting to PostgreSQL...");
  const status = await checkDatabaseConnection();

  if (!status.connected) {
    console.error("[db:init] Connection failed:", status.error);
    process.exit(1);
  }

  console.log("[db:init] Creating enum types and tables (accounts, payments)...");
  await initDatabase();
  console.log("[db:init] Schema initialized successfully!");

  await closeDatabaseConnection();
  process.exit(0);
}

main().catch((err) => {
  console.error("[db:init] Fatal error:", err);
  process.exit(1);
});

