/**
 * v1.40 — TanStack Query keys for background document AI runs. A run is
 * polled until it ends and then dropped from the cache, so the result (model
 * text, lab values) does not linger in memory past the screen that asked.
 */
export const aiRunKeys = {
  aiRuns: () => ["ai-runs"] as const,
  aiRun: (runId: string) => ["ai-runs", runId] as const,
};
