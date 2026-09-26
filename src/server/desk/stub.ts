import type { Env } from '../env';
import type { TradingDesk } from './desk';

/** Typed RPC stub for the single desk instance (`idFromName('desk')`). */
export function deskStub(env: Env): DurableObjectStub<TradingDesk> {
  return env.DESK.get(env.DESK.idFromName('desk')) as DurableObjectStub<TradingDesk>;
}
