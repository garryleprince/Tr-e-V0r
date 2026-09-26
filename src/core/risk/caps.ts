/**
 * Absolute ceilings no setting can exceed, whatever the UI or an API call sends.
 * Kept free of any dependency so the interface can display them.
 */
export const HARD_CAPS = {
  maxRiskPerTradePct: 5,
  maxPositionPct: 100,
  maxGrossExposurePct: 100, // no leverage
  maxOpenPositions: 20,
  maxDailyLossPct: 20,
  maxDrawdownPct: 50,
  maxNewOrdersPerDay: 50,
  maxAtrPct: 50,
  maxSpreadBps: 500,
  maxCorrelation: 1,
  maxStopDistancePct: 50,
  llmDailyBudgetUsd: 100,
} as const;
