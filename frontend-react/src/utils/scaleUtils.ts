import type { ScaleType } from '@/types';

/**
 * Tunable thresholds. Defaults match the old hardcoded values; overwritten once at
 * boot from GET /api/settings/public (see loadThresholds). Read at call time —
 * never destructure into module constants.
 *  - smallScaleMaxKg:    target ≤ this → small scale, else large
 *  - weightTolerance:    symmetric ± fraction around target (green + confirm window)
 *  - autoConfirmDelayMs: wait after confirm before advancing to next RM
 *  - skipKemasanDelayMs: flash time for auto-skipped Kemasan
 */
export const thresholds = {
  smallScaleMaxKg:    20,
  weightTolerance:    0.02,
  autoConfirmDelayMs: 3000,
  skipKemasanDelayMs: 3000,
};

/** Fetch thresholds from backend; any failure keeps the defaults above. */
export async function loadThresholds(timeoutMs = 2000): Promise<void> {
  try {
    const res = await fetch('/api/settings/public', { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (!res.ok || !body.success) return;
    for (const k of Object.keys(thresholds) as (keyof typeof thresholds)[]) {
      const v = body.data?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) thresholds[k] = v;
    }
  } catch { /* keep defaults */ }
}

/** Determine which physical scale should handle the given target weight. */
export function getScaleForWeight(targetKg: number): ScaleType {
  return targetKg <= thresholds.smallScaleMaxKg ? 'small' : 'large';
}

/** Visual progress ratio capped at 1.1 so the bar never overflows wildly */
export function calcProgressRatio(weight: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(weight / target, 1.1);
}

export type ProgressState = 'normal' | 'near' | 'ok' | 'over';

/**
 * Classify current fill state for colour coding.
 *  - over   > target + tol  (red)
 *  - ok     within ± tol    (green — at/around target)
 *  - near   ≥ 90%           (amber warning)
 *  - normal < 90%
 */
export function getProgressState(ratio: number): ProgressState {
  if (ratio > 1 + thresholds.weightTolerance) return 'over';
  if (ratio >= 1 - thresholds.weightTolerance) return 'ok';
  if (ratio >= 0.9)  return 'near';
  return 'normal';
}

/** Format weight for display, always 2 decimal places */
export function formatWeight(value: number): string {
  return value.toFixed(2);
}
