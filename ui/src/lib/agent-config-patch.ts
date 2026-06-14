import type { Agent } from "@paperclipai/shared";

export interface AgentModelProfileOverlay {
  enabled?: boolean;
  adapterConfig?: Record<string, unknown>;
  /**
   * Mark the cheap profile for clearing. When true, the patch removes
   * `runtimeConfig.modelProfiles.cheap` instead of merging into it.
   */
  cleared?: boolean;
}

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  /** Fallback adapter to use when the primary hits a usage/quota limit. */
  fallbackAdapterType?: string | null;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
  modelProfiles?: { cheap?: AgentModelProfileOverlay };
}

export const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
] as const;

function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.fallbackAdapterType !== undefined) {
    patch.fallbackAdapterType = overlay.fallbackAdapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  const cheapOverlay = overlay.modelProfiles?.cheap;
  const hasModelProfileChange = cheapOverlay !== undefined;

  if (Object.keys(overlay.heartbeat).length > 0 || hasModelProfileChange) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = (patch.runtimeConfig as Record<string, unknown> | undefined)
      ?? { ...existingRc };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }

    if (hasModelProfileChange) {
      const existingProfiles = ((existingRc.modelProfiles ?? {}) as Record<string, unknown>);
      const existingCheap = ((existingProfiles.cheap ?? {}) as Record<string, unknown>);
      const nextProfiles = { ...existingProfiles };

      if (cheapOverlay?.cleared) {
        // An adapter switch cleared the previous adapter's cheap profile. Honor
        // any explicit choice the user made after switching (disabling it, or
        // picking a new model) instead of always deleting — otherwise a disabled
        // cheap profile would be dropped and revert to the enabled-by-default
        // state on the next load. Drop the profile only when no explicit choice
        // was made.
        const explicitModel = (cheapOverlay.adapterConfig as Record<string, unknown> | undefined)?.model;
        const hasExplicitModel = typeof explicitModel === "string" && explicitModel.length > 0;
        if (cheapOverlay.enabled === false || hasExplicitModel) {
          nextProfiles.cheap = {
            enabled: cheapOverlay.enabled ?? true,
            adapterConfig: hasExplicitModel ? { model: explicitModel } : {},
          };
        } else {
          delete nextProfiles.cheap;
        }
      } else if (cheapOverlay) {
        const mergedAdapterConfig = {
          ...((existingCheap.adapterConfig ?? {}) as Record<string, unknown>),
          ...(cheapOverlay.adapterConfig ?? {}),
        };
        const enabled = cheapOverlay.enabled ?? (existingCheap.enabled !== false);
        nextProfiles.cheap = {
          ...existingCheap,
          enabled,
          adapterConfig: mergedAdapterConfig,
        };
      }

      if (Object.keys(nextProfiles).length === 0) {
        delete nextRuntimeConfig.modelProfiles;
      } else {
        nextRuntimeConfig.modelProfiles = nextProfiles;
      }
    }

    patch.runtimeConfig = nextRuntimeConfig;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
