const triggers = new Set(['startup', 'periodic', 'watcher', 'manual']);
const states = new Set(['queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled']);

/** Keeps Prometheus cardinality bounded even if historical rows were corrupted or upgraded. */
export function reconciliationMetricLabels(
  trigger: string,
  state: string,
): { trigger: string; state: string } | null {
  if (!triggers.has(trigger) || !states.has(state)) return null;
  return { trigger, state };
}
