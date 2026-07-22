/**
 * Running supplier lead-time statistics.
 *
 * The original incremental update was:
 *
 *   newAvg      = (currentAvg * n + observed) / (n + 1)
 *   newVariance = sqrt((oldVar^2 * n + (observed - newAvg)^2) / (n + 1))
 *
 * which mixes the *new* mean with squared deviations accumulated around *old* means. It
 * does not converge to the standard deviation of the observations. That figure feeds
 * calculateSafetyStock directly — via the Z * avgDailySales * sigma_leadTime term — so
 * every buffer for that supplier was sized off a number that did not mean anything.
 *
 * Welford's algorithm keeps a running mean and M2 (sum of squared deviations from the
 * running mean) and is exact for streaming data.
 */

export interface LeadTimeStats {
  /** Number of receipts observed. */
  count: number;
  /** Running mean lead time in days. */
  mean: number;
  /** Sum of squared deviations from the running mean. */
  m2: number;
  /** Sample standard deviation; 0 until there are at least two observations. */
  stdDev: number;
}

export function updateLeadTimeStats(
  prev: { count: number; mean: number | null; m2: number },
  observedDays: number,
): LeadTimeStats {
  const count = prev.count + 1;
  const prevMean = prev.mean ?? observedDays;
  const mean = prevMean + (observedDays - prevMean) / count;
  const m2 = prev.m2 + (observedDays - prevMean) * (observedDays - mean);
  const stdDev = count > 1 ? Math.sqrt(m2 / (count - 1)) : 0;
  return { count, mean, m2, stdDev };
}
