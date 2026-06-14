import { describe, expect, it } from "vitest";
import {
  buildFallbackRevertPlan,
  buildFallbackSwapPlan,
  parseFallbackState,
  shouldActivateUsageLimitFallback,
  shouldRevertFallback,
} from "./adapter-fallback.js";

describe("adapter fallback decision logic", () => {
  describe("shouldActivateUsageLimitFallback", () => {
    const base = {
      currentAdapterType: "claude_local",
      fallbackAdapterType: "codex_local",
      retryNotBefore: new Date("2026-06-14T10:00:00Z"),
      fallbackState: null,
    };

    it("activates on a usage limit with a reset window when a fallback is set", () => {
      expect(shouldActivateUsageLimitFallback(base)).toBe(true);
    });

    it("does not activate when no fallback adapter is configured", () => {
      expect(shouldActivateUsageLimitFallback({ ...base, fallbackAdapterType: null })).toBe(false);
      expect(shouldActivateUsageLimitFallback({ ...base, fallbackAdapterType: "  " })).toBe(false);
    });

    it("does not activate for brief throttling without a reset window", () => {
      expect(shouldActivateUsageLimitFallback({ ...base, retryNotBefore: null })).toBe(false);
    });

    it("does not activate when the fallback equals the primary adapter", () => {
      expect(
        shouldActivateUsageLimitFallback({ ...base, fallbackAdapterType: "claude_local" }),
      ).toBe(false);
    });

    it("does not activate when already running on the fallback", () => {
      expect(
        shouldActivateUsageLimitFallback({
          ...base,
          fallbackState: {
            active: true,
            primaryAdapterType: "claude_local",
            primaryResetAt: "2026-06-14T10:00:00Z",
            activatedAt: "2026-06-14T05:00:00Z",
          },
        }),
      ).toBe(false);
    });
  });

  describe("shouldRevertFallback", () => {
    const state = {
      active: true as const,
      primaryAdapterType: "claude_local",
      primaryResetAt: "2026-06-14T10:00:00Z",
      activatedAt: "2026-06-14T05:00:00Z",
    };

    it("reverts once the primary reset time has passed", () => {
      expect(
        shouldRevertFallback({
          fallbackState: state,
          currentAdapterType: "codex_local",
          now: new Date("2026-06-14T10:00:01Z"),
        }),
      ).toBe(true);
    });

    it("stays on the fallback before the reset time", () => {
      expect(
        shouldRevertFallback({
          fallbackState: state,
          currentAdapterType: "codex_local",
          now: new Date("2026-06-14T09:59:59Z"),
        }),
      ).toBe(false);
    });

    it("does nothing when already back on the primary adapter", () => {
      expect(
        shouldRevertFallback({
          fallbackState: state,
          currentAdapterType: "claude_local",
          now: new Date("2026-06-14T12:00:00Z"),
        }),
      ).toBe(false);
    });

    it("does nothing when no fallback is active", () => {
      expect(
        shouldRevertFallback({
          fallbackState: null,
          currentAdapterType: "codex_local",
          now: new Date(),
        }),
      ).toBe(false);
    });
  });

  describe("buildFallbackSwapPlan", () => {
    it("archives the primary config and restores the fallback config", () => {
      const plan = buildFallbackSwapPlan({
        currentAdapterType: "claude_local",
        currentAdapterConfig: { model: "opus", cwd: "/work" },
        fallbackAdapterType: "codex_local",
        adapterConfigArchive: { codex_local: { model: "gpt-5", dangerouslyBypassSandbox: true } },
        primaryResetAt: new Date("2026-06-14T10:00:00Z"),
        now: new Date("2026-06-14T05:00:00Z"),
      });

      expect(plan.adapterType).toBe("codex_local");
      expect(plan.adapterConfig).toEqual({ model: "gpt-5", dangerouslyBypassSandbox: true });
      expect(plan.adapterConfigArchive.claude_local).toEqual({ model: "opus", cwd: "/work" });
      expect(plan.fallbackState).toEqual({
        active: true,
        primaryAdapterType: "claude_local",
        primaryResetAt: "2026-06-14T10:00:00.000Z",
        activatedAt: "2026-06-14T05:00:00.000Z",
      });
    });

    it("falls back to an empty config when the fallback was never configured", () => {
      const plan = buildFallbackSwapPlan({
        currentAdapterType: "claude_local",
        currentAdapterConfig: { model: "opus" },
        fallbackAdapterType: "codex_local",
        adapterConfigArchive: {},
        primaryResetAt: new Date("2026-06-14T10:00:00Z"),
        now: new Date("2026-06-14T05:00:00Z"),
      });
      expect(plan.adapterConfig).toEqual({});
    });
  });

  describe("buildFallbackRevertPlan", () => {
    it("restores the primary config and clears the fallback state", () => {
      const plan = buildFallbackRevertPlan({
        currentAdapterType: "codex_local",
        currentAdapterConfig: { model: "gpt-5-codex" },
        fallbackState: {
          active: true,
          primaryAdapterType: "claude_local",
          primaryResetAt: "2026-06-14T10:00:00Z",
          activatedAt: "2026-06-14T05:00:00Z",
        },
        adapterConfigArchive: { claude_local: { model: "opus", cwd: "/work" } },
      });

      expect(plan.adapterType).toBe("claude_local");
      expect(plan.adapterConfig).toEqual({ model: "opus", cwd: "/work" });
      // The fallback's working config is preserved for next time.
      expect(plan.adapterConfigArchive.codex_local).toEqual({ model: "gpt-5-codex" });
      expect(plan.fallbackState).toBeNull();
    });
  });

  describe("parseFallbackState", () => {
    it("returns null for inactive or malformed values", () => {
      expect(parseFallbackState(null)).toBeNull();
      expect(parseFallbackState({ active: false })).toBeNull();
      expect(parseFallbackState({ active: true })).toBeNull();
      expect(parseFallbackState("nope")).toBeNull();
    });

    it("parses a valid active state", () => {
      expect(
        parseFallbackState({
          active: true,
          primaryAdapterType: "claude_local",
          primaryResetAt: "2026-06-14T10:00:00Z",
          activatedAt: "2026-06-14T05:00:00Z",
        }),
      ).toEqual({
        active: true,
        primaryAdapterType: "claude_local",
        primaryResetAt: "2026-06-14T10:00:00Z",
        activatedAt: "2026-06-14T05:00:00Z",
      });
    });
  });
});
