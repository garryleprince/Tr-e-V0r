import type { AgentId, DecisionStatus, Stance, TradeAction } from './domain/analysis';
import type { ExitReason, Mode, TradingState } from './domain/trading';
import type { RiskLimits } from './risk/limits';

/**
 * French labels shared by the server (events, messages) and the interface.
 * Type-only imports: this module pulls no runtime dependency into the web bundle.
 */

export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  RESEARCH: 'Recherche',
  PAPER: 'Simulation',
  LIVE: 'Réel',
};

export const TRADING_STATE_LABELS: Readonly<Record<TradingState, string>> = {
  ACTIVE: 'Actif',
  REDUCING: 'Réduction seule',
  HALTED: 'Arrêté',
};

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  technical: 'Analyste technique',
  fundamental: 'Analyste fondamental',
  sentiment: 'Analyste sentiment',
  macro: 'Analyste macro',
};

export const STANCE_LABELS: Readonly<Record<Stance, string>> = {
  bullish: 'Haussier',
  bearish: 'Baissier',
  neutral: 'Neutre',
};

export const ACTION_LABELS: Readonly<Record<TradeAction, string>> = {
  BUY: 'Achat',
  SELL: 'Vente',
  HOLD: 'Attente',
};

export const DECISION_STATUS_LABELS: Readonly<Record<DecisionStatus, string>> = {
  PROPOSED: 'Proposée',
  APPROVED: 'Approuvée',
  RESIZED: 'Réduite par le risque',
  REJECTED: 'Refusée par le risque',
  EXECUTED: 'Exécutée',
  NOT_EXECUTED: 'Non exécutée',
  INVALID: 'Invalide',
};

export const EXIT_REASON_LABELS: Readonly<Record<ExitReason, string>> = {
  stop: 'Stop-loss',
  target: 'Objectif',
  time: 'Horizon atteint',
  signal: 'Décision IA',
  manual: 'Clôture manuelle',
  risk: 'Coupure du risque',
};

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
