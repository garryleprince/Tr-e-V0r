import type { TradeProposal } from '../domain/analysis';
import type { TechnicalSnapshot } from '../quant/features';

/**
 * Checks a schema-valid proposal against the facts it was built from.
 *
 * A model can return well-formed JSON that is still wrong: a stop above the
 * entry, an entry 30 % away from the market (a hallucinated or stale level),
 * scenario probabilities that make no sense. Such a proposal becomes an INVALID
 * decision — it is never quietly turned into a HOLD (TradingAgents' REVIEW
 * sentinel).
 */

export const MAX_ENTRY_DEVIATION = 0.02;

export function checkProposal(
  p: TradeProposal,
  snapshot: TechnicalSnapshot,
  holding: boolean,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const ref = snapshot.lastClose;

  if (p.action === 'HOLD') return { ok: true };

  if (p.action === 'SELL' && !holding) {
    reasons.push('SELL sans position détenue : la vente à découvert est interdite');
  }

  if (p.entryPrice === null) {
    reasons.push(`${p.action} sans prix d’entrée`);
  } else {
    const deviation = Math.abs(p.entryPrice / ref - 1);
    if (deviation > MAX_ENTRY_DEVIATION) {
      reasons.push(
        `entrée à ${p.entryPrice} éloignée de ${(deviation * 100).toFixed(2)} % du dernier cours ${ref} (maximum ${MAX_ENTRY_DEVIATION * 100} %)`,
      );
    }
  }

  if (p.action === 'BUY') {
    if (p.stopLoss === null) reasons.push('BUY sans stop-loss');
    if (p.entryPrice !== null && p.stopLoss !== null && p.stopLoss >= p.entryPrice) {
      reasons.push(`stop-loss ${p.stopLoss} au-dessus ou au niveau de l’entrée ${p.entryPrice}`);
    }
    if (p.entryPrice !== null && p.takeProfit !== null && p.takeProfit <= p.entryPrice) {
      reasons.push(`objectif ${p.takeProfit} sous ou au niveau de l’entrée ${p.entryPrice}`);
    }
  }

  const probabilitySum = p.mainScenario.probability + p.altScenario.probability;
  if (probabilitySum > 1.05) {
    reasons.push(`probabilités des scénarios incohérentes (somme ${probabilitySum.toFixed(2)} > 1)`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
