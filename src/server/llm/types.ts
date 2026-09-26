import type { ZodType } from 'zod';

/**
 * Provider-agnostic LLM port (docs/AGENTS_IA.md §4).
 *
 * No provider type crosses this boundary. Switching from Claude to GPT, Gemini
 * or a local model is a settings change, not a code change.
 */

export type LlmTier = 'deep' | 'quick';
export type Effort = 'low' | 'medium' | 'high';

export interface StructuredRequest<T> {
  readonly tier: LlmTier;
  /** Constant text, cacheable by the provider. */
  readonly system: string;
  /** Per-call data (JSON). */
  readonly user: string;
  /** Shape the model must produce (wire schema, without numeric bounds). */
  readonly schema: ZodType<T>;
  readonly schemaName: string;
  readonly maxOutputTokens: number;
}

export interface LlmUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** True when the model is absent from the price table (cost estimated high). */
  readonly costEstimated: boolean;
  readonly latencyMs: number;
}

export type LlmErrorKind =
  | 'refusal'
  | 'invalid_output'
  | 'transport'
  | 'rate_limited'
  | 'not_configured'
  | 'budget_exceeded';

export type StructuredResult<T> =
  | { readonly ok: true; readonly value: T; readonly usage: LlmUsage; readonly raw: string }
  | {
      readonly ok: false;
      readonly error: { readonly kind: LlmErrorKind; readonly message: string };
      readonly usage?: LlmUsage;
      readonly raw?: string;
    };

export interface LlmProvider {
  readonly id: string;
  /** Model used for a tier, for display and pricing. */
  model(tier: LlmTier): string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export const LLM_ERROR_LABELS: Readonly<Record<LlmErrorKind, string>> = {
  refusal: 'le modèle a refusé la requête',
  invalid_output: 'réponse du modèle invalide',
  transport: 'erreur de communication avec le fournisseur',
  rate_limited: 'limite de requêtes du fournisseur atteinte',
  not_configured: 'fournisseur IA non configuré',
  budget_exceeded: 'budget IA journalier atteint',
};
