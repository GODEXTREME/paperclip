import type { AdapterFallbackState } from "@paperclipai/shared";

/**
 * Pure decision logic for the adapter usage-limit fallback.
 *
 * The heartbeat owns the side effects (mutating the agent row, clearing the
 * session, scheduling the retry). This module only decides *whether* a swap or
 * revert should happen and *what* the resulting adapter config / fallback state
 * should look like, so the rules stay testable in isolation.
 *
 * Trigger policy (per product decision): the fallback only engages on a genuine
 * usage/quota limit — a transient upstream failure that carries a reset window
 * (`primaryResetAt`). Brief throttling (429/overloaded without a reset time) is
 * left to the normal bounded-retry path and does NOT swap adapters.
 */

export type { AdapterFallbackState };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a persisted `agents.fallback_state` JSON blob into a typed
 * AdapterFallbackState, or null when it is absent/inactive/malformed.
 */
export function parseFallbackState(value: unknown): AdapterFallbackState | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.active !== true) return null;
  const primaryAdapterType =
    typeof record.primaryAdapterType === "string" && record.primaryAdapterType.length > 0
      ? record.primaryAdapterType
      : null;
  if (!primaryAdapterType) return null;
  const primaryResetAt =
    typeof record.primaryResetAt === "string" && record.primaryResetAt.length > 0
      ? record.primaryResetAt
      : null;
  const activatedAt =
    typeof record.activatedAt === "string" && record.activatedAt.length > 0
      ? record.activatedAt
      : new Date(0).toISOString();
  return { active: true, primaryAdapterType, primaryResetAt, activatedAt };
}

/**
 * Decide whether the agent should swap onto its fallback adapter because the
 * primary adapter just hit a usage/quota limit.
 */
export function shouldActivateUsageLimitFallback(input: {
  currentAdapterType: string;
  fallbackAdapterType: string | null | undefined;
  /** Reset window from the usage-limit failure; null means "not a usage limit". */
  retryNotBefore: Date | null;
  fallbackState: AdapterFallbackState | null;
}): boolean {
  const fallback = input.fallbackAdapterType?.trim();
  if (!fallback) return false;
  // Only usage/quota limits (which carry a reset window) trigger the swap.
  if (!input.retryNotBefore) return false;
  // Misconfigured (fallback == primary) or already running on the fallback.
  if (fallback === input.currentAdapterType) return false;
  if (input.fallbackState?.active) return false;
  return true;
}

/**
 * Decide whether an agent currently running on its fallback should revert to the
 * primary adapter. Revert happens lazily on the next run once the primary's
 * usage window has reset.
 */
export function shouldRevertFallback(input: {
  fallbackState: AdapterFallbackState | null;
  currentAdapterType: string;
  now: Date;
}): boolean {
  const state = input.fallbackState;
  if (!state?.active) return false;
  // Already back on the primary adapter — nothing to revert.
  if (input.currentAdapterType === state.primaryAdapterType) return false;
  // Without a known reset time we keep the agent on the fallback rather than
  // ping-ponging; activation always records a reset time, so this is defensive.
  if (!state.primaryResetAt) return false;
  const resetAt = new Date(state.primaryResetAt);
  if (Number.isNaN(resetAt.getTime())) return false;
  return resetAt.getTime() <= input.now.getTime();
}

export interface AdapterSwapPlan {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  adapterConfigArchive: Record<string, Record<string, unknown>>;
  fallbackState: AdapterFallbackState | null;
}

function cloneArchive(
  archive: Record<string, Record<string, unknown>> | null | undefined,
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = {};
  if (!archive) return next;
  for (const [key, value] of Object.entries(archive)) {
    const record = asRecord(value);
    if (record) next[key] = { ...record };
  }
  return next;
}

/**
 * Build the agent mutation for swapping onto the fallback adapter. Archives the
 * current (primary) config under its type, restores the fallback's previously
 * saved config from the archive (empty when never configured), and records the
 * activation state with the primary's reset window.
 */
export function buildFallbackSwapPlan(input: {
  currentAdapterType: string;
  currentAdapterConfig: Record<string, unknown>;
  fallbackAdapterType: string;
  adapterConfigArchive: Record<string, Record<string, unknown>> | null | undefined;
  primaryResetAt: Date;
  now: Date;
}): AdapterSwapPlan {
  const archive = cloneArchive(input.adapterConfigArchive);
  // Preserve the primary adapter's config so we can restore it on revert.
  archive[input.currentAdapterType] = { ...input.currentAdapterConfig };
  const restoredFallbackConfig = { ...(archive[input.fallbackAdapterType] ?? {}) };
  return {
    adapterType: input.fallbackAdapterType,
    adapterConfig: restoredFallbackConfig,
    adapterConfigArchive: archive,
    fallbackState: {
      active: true,
      primaryAdapterType: input.currentAdapterType,
      primaryResetAt: input.primaryResetAt.toISOString(),
      activatedAt: input.now.toISOString(),
    },
  };
}

/**
 * Build the agent mutation for reverting from the fallback back to the primary
 * adapter once its usage window has reset. Archives the fallback's current
 * config and restores the primary's saved config.
 */
export function buildFallbackRevertPlan(input: {
  currentAdapterType: string;
  currentAdapterConfig: Record<string, unknown>;
  fallbackState: AdapterFallbackState;
  adapterConfigArchive: Record<string, Record<string, unknown>> | null | undefined;
}): AdapterSwapPlan {
  const archive = cloneArchive(input.adapterConfigArchive);
  // Preserve any changes made to the fallback adapter's config while active.
  archive[input.currentAdapterType] = { ...input.currentAdapterConfig };
  const primaryType = input.fallbackState.primaryAdapterType;
  const restoredPrimaryConfig = { ...(archive[primaryType] ?? {}) };
  return {
    adapterType: primaryType,
    adapterConfig: restoredPrimaryConfig,
    adapterConfigArchive: archive,
    fallbackState: null,
  };
}
