/**
 * Ordinary-JSON sidecar for generated-layout overrides.
 *
 * The sidecar is a plain file the workspace layer can store next to the
 * `.d2` source (e.g. `<name>.d2.json`). It records only what the user
 * changed relative to the last generated baseline, so regeneration can
 * re-apply explicit overrides after the source moves. Parsing validates
 * the shape and rejects anything else with a descriptive error.
 */
import type { OverrideSidecar } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeOverrideSidecar(sidecar: OverrideSidecar): string {
  if (!isRecord(sidecar as unknown) || sidecar.version !== 1) {
    throw new Error('invalid override sidecar: expected { version: 1, ... }');
  }
  if (!('baseline' in sidecar)) {
    throw new Error('invalid override sidecar: expected a baseline (or null)');
  }
  return JSON.stringify(sidecar, null, 2) + '\n';
}

export function parseOverrideSidecar(text: string): OverrideSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid override sidecar: not JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('invalid override sidecar: expected a JSON object');
  }
  if (parsed['version'] !== 1) {
    throw new Error('invalid override sidecar: expected version 1');
  }
  if (parsed['language'] !== 'd2') {
    throw new Error('invalid override sidecar: expected language "d2"');
  }
  if (typeof parsed['sourceHash'] !== 'string') {
    throw new Error('invalid override sidecar: expected a sourceHash string');
  }
  if (!isRecord(parsed['overrides'])) {
    throw new Error('invalid override sidecar: expected an overrides object');
  }
  for (const [key, value] of Object.entries(parsed['overrides'])) {
    if (!isRecord(value)) {
      throw new Error(`invalid override sidecar: override for "${key}" must be an object`);
    }
  }
  // Baseline persistence (reopen merge base). Sidecars written before it
  // lack the key entirely: recoverable as null, never a parse failure.
  const baseline = parsed['baseline'];
  if (baseline !== undefined && baseline !== null) {
    if (!isRecord(baseline)) {
      throw new Error('invalid override sidecar: expected a baseline object or null');
    }
    if (baseline['language'] !== 'd2') {
      throw new Error('invalid override sidecar: expected baseline language "d2"');
    }
    if (typeof baseline['sourceHash'] !== 'string') {
      throw new Error('invalid override sidecar: expected a baseline sourceHash string');
    }
    if (!isRecord(baseline['elements'])) {
      throw new Error('invalid override sidecar: expected baseline elements object');
    }
  }
  return {
    ...(parsed as unknown as OverrideSidecar),
    baseline: (baseline ?? null) as OverrideSidecar['baseline'],
  };
}
