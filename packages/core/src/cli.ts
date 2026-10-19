import { main } from "./main.js";

main().catch((err) => {
  process.stderr.write(`Failed to start MCP Hub: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
