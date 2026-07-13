/**
 * 07-03/D-01: the single shared source for every percentage across the
 * campaign summary, campaign list (and, later, flow analytics + dashboard
 * KPIs). Returns null on a zero denominator so callers render «—» instead of
 * NaN%/Infinity% (T-07-03-02).
 */
export function computeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}
