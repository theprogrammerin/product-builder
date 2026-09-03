export interface HealthCheckOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Polls a URL until it responds at all (any HTTP status) or timeoutMs
 * elapses. "Responds at all" is the bar — this confirms the server is up
 * and reachable, not that the app behind it is bug-free; that's what
 * verification (rspec/jest) is for.
 */
export async function waitForHealthy(url: string, options: HealthCheckOptions = {}): Promise<boolean> {
  const { timeoutMs = 60_000, intervalMs = 1000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return true;
    } catch {
      // Connection refused / not listening yet — keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
