import { z } from 'zod';

/**
 * Risk limits.
 *
 * Every limit is user-adjustable inside a HARD ceiling that lives in code. No
 * setting, API call or model output can push a limit beyond its ceiling — the
 * schema below rejects it. Tightening is free; loosening requires a fresh
 * re-authentication (enforced by the API layer with `isLoosening`).
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

export const RiskLimitsSchema = z.strictObject({
  maxRiskPerTradePct: z.number().gt(0).max(HARD_CAPS.maxRiskPerTradePct),
  maxPositionPct: z.number().gt(0).max(HARD_CAPS.maxPositionPct),
  maxGrossExposurePct: z.number().gt(0).max(HARD_CAPS.maxGrossExposurePct),
  maxOpenPositions: z.number().int().min(1).max(HARD_CAPS.maxOpenPositions),
  maxDailyLossPct: z.number().gt(0).max(HARD_CAPS.maxDailyLossPct),
  maxDrawdownPct: z.number().gt(0).max(HARD_CAPS.maxDrawdownPct),
  maxConsecutiveLosses: z.number().int().min(1).max(20),
  cooldownHours: z.number().min(0).max(24 * 14),
  maxAtrPct: z.number().gt(0).max(HARD_CAPS.maxAtrPct),
  minConfidence: z.number().min(0).max(1),
  minRewardRisk: z.number().min(0).max(10),
  minStopDistanceAtr: z.number().min(0).max(10),
  maxStopDistancePct: z.number().gt(0).max(HARD_CAPS.maxStopDistancePct),
  maxEntryDeviationPct: z.number().gt(0).max(10),
  maxCorrelation: z.number().gt(0).max(HARD_CAPS.maxCorrelation),
  minAvgDollarVolume: z.number().min(0),
  maxParticipationPct: z.number().gt(0).max(100),
  maxSpreadBps: z.number().gt(0).max(HARD_CAPS.maxSpreadBps),
  maxNewOrdersPerDay: z.number().int().min(0).max(HARD_CAPS.maxNewOrdersPerDay),
  /** Maximum data age, as a multiple of the timeframe. */
  maxDataAgeBars: z.number().min(1).max(10),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

/** Conservative defaults (docs/RISQUE_ET_SECURITE.md §A.2). */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 1,
  maxPositionPct: 20,
  maxGrossExposurePct: 60,
  maxOpenPositions: 3,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  maxConsecutiveLosses: 3,
  cooldownHours: 24,
  maxAtrPct: 10,
  minConfidence: 0.55,
  minRewardRisk: 1.2,
  minStopDistanceAtr: 0.5,
  maxStopDistancePct: 15,
  maxEntryDeviationPct: 2,
  maxCorrelation: 0.8,
  minAvgDollarVolume: 5_000_000,
  maxParticipationPct: 1,
  maxSpreadBps: 30,
  maxNewOrdersPerDay: 5,
  maxDataAgeBars: 2,
};

/**
 * For each limit, which direction is "looser". Returns the names of limits that
 * `next` loosens compared with `current`.
 */
export function looseningChanges(current: RiskLimits, next: RiskLimits): string[] {
  const higherIsLooser: (keyof RiskLimits)[] = [
    'maxRiskPerTradePct',
    'maxPositionPct',
    'maxGrossExposurePct',
    'maxOpenPositions',
    'maxDailyLossPct',
    'maxDrawdownPct',
    'maxConsecutiveLosses',
    'maxAtrPct',
    'maxStopDistancePct',
    'maxEntryDeviationPct',
    'maxCorrelation',
    'maxParticipationPct',
    'maxSpreadBps',
    'maxNewOrdersPerDay',
    'maxDataAgeBars',
  ];
  const lowerIsLooser: (keyof RiskLimits)[] = [
    'cooldownHours',
    'minConfidence',
    'minRewardRisk',
    'minStopDistanceAtr',
    'minAvgDollarVolume',
  ];
  return [
    ...higherIsLooser.filter((k) => next[k] > current[k]),
    ...lowerIsLooser.filter((k) => next[k] < current[k]),
  ];
}

export const RISK_LIMIT_LABELS: Readonly<Record<keyof RiskLimits, string>> = {
  maxRiskPerTradePct: 'Risque maximal par trade (% du capital)',
  maxPositionPct: 'Taille maximale d’une position (% du capital)',
  maxGrossExposurePct: 'Exposition totale maximale (% du capital)',
  maxOpenPositions: 'Positions simultanées maximales',
  maxDailyLossPct: 'Perte journalière maximale (%)',
  maxDrawdownPct: 'Drawdown maximal avant coupure (%)',
  maxConsecutiveLosses: 'Pertes consécutives avant pause',
  cooldownHours: 'Durée de la pause après pertes (heures)',
  maxAtrPct: 'Volatilité maximale (ATR en % du prix)',
  minConfidence: 'Confiance minimale de l’IA',
  minRewardRisk: 'Rapport gain/risque minimal',
  minStopDistanceAtr: 'Distance minimale du stop (en ATR)',
  maxStopDistancePct: 'Distance maximale du stop (%)',
  maxEntryDeviationPct: 'Écart maximal entrée / marché (%)',
  maxCorrelation: 'Corrélation maximale entre positions',
  minAvgDollarVolume: 'Liquidité minimale (volume moyen par bougie, $)',
  maxParticipationPct: 'Part maximale du volume moyen (%)',
  maxSpreadBps: 'Spread maximal (points de base)',
  maxNewOrdersPerDay: 'Nouveaux ordres maximum par jour',
  maxDataAgeBars: 'Âge maximal des données (en bougies)',
};
