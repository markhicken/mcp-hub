const started = Date.now();

/**
 * Startup progress on stderr, only when `MCP_HUB_TRACE` is set (the sidecar smoke test sets it), so a start that stalls
 * can say where. Silent otherwise. Never includes paths, secrets or arguments, only the step's name.
 */
export function trace(step: string): void {
  if (process.env.MCP_HUB_TRACE) process.stderr.write(`[trace +${Date.now() - started}ms] ${step}\n`);
}
