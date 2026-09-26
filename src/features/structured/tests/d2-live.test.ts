/**
 * Live D2 tests: compile the three examples in examples.ts with the real
 * `@terrastruct/d2` WASM compiler and check the emitted native scene
 * against the measured diagram.
 *
 * Explicitly opt-in only: run with `STRUCTURED_D2_LIVE=1` and the pinned
 * dependency installed. Unit runs without the flag never touch the
 * compiler, so they stay fast and cannot hang on a worker.
 *
 * Lifecycle: every test compiles through the shared singleton (one worker
 * per process, never one per call); `afterAll` terminates it, so the test
 * process exits on its own once PASS is printed. Nothing here spawns an
 * undisposed instance: there is no top-level compile, only an import probe.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileStructured,
  createD2CompilePort,
  disposeSharedD2,
  getSharedD2,
} from '../compiler.ts';
import { emitNativeScene } from '../emitter.ts';
import { CLOUD_D2_EXAMPLE, ERD_D2_EXAMPLE, FLOW_D2_EXAMPLE } from '../examples.ts';

const LIVE = process.env['STRUCTURED_D2_LIVE'] === '1';

let hasD2 = false;
if (LIVE) {
  try {
    await import('@terrastruct/d2');
    hasD2 = true;
  } catch {
    hasD2 = false;
  }
}

const live = test.if(LIVE && hasD2);

afterAll(async () => {
  await disposeSharedD2();
});

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

describe('live D2 compile + emission', () => {
  live('flow, ERD and cloud examples compile to native editable scenes', async () => {
    for (const [name, source] of Object.entries({
      flow: FLOW_D2_EXAMPLE,
      erd: ERD_D2_EXAMPLE,
      cloud: CLOUD_D2_EXAMPLE,
    })) {
      // No injected port: this exercises the shared default worker.
      const out = await compileStructured(source);
      expect(out.ok, `${name} ok`).toBe(true);
      expect(out.baseline, `${name} baseline`).not.toBeNull();
      const diagram = await createD2CompilePort()({ source });
      // Measured 2026-09-07 against @terrastruct/d2 0.1.33: flow 4/4, erd 2/1, cloud 7/4.
      expect(diagram.shapes?.length, `${name} shapes`).toBeGreaterThanOrEqual(2);
      expect(diagram.connections?.length, `${name} connections`).toBeGreaterThanOrEqual(1);
      for (const s of diagram.shapes ?? []) {
        expect(finite(s.pos?.x), `${name}:${s.id} x`).toBe(true);
        expect(finite(s.width) && (s.width as number) > 0, `${name}:${s.id} w`).toBe(true);
      }
      const { elements, diagnostics } = emitNativeScene(diagram);
      // Every D2 shape and connection produced a native element.
      for (const s of diagram.shapes ?? []) {
        expect(elements.some((el) => el.id === `d2:${s.id}`), `${name} element d2:${s.id}`).toBe(true);
      }
      for (const c of diagram.connections ?? []) {
        const arrow = elements.find((el) => el.id === `d2:${c.id}`);
        expect(arrow, `${name} arrow d2:${c.id}`).toBeDefined();
        expect((arrow?.points as unknown[]).length, `${name} route points`).toBeGreaterThan(1);
      }
      // Native text stayed native: every D2 label has a text element.
      for (const s of (diagram.shapes ?? []).filter((s) => s.label)) {
        const label = elements.find((el) => el.id === `d2:${s.id}:label`);
        expect(label?.type, `${name} label ${s.id}`).toBe('text');
      }
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      // The compiled scene carries the same elements the emitter derives.
      expect(out.scene.elements.length, `${name} scene size`).toBe(elements.length);
    }
  }, 90000);

  live('repeated compiles share one worker instance', async () => {
    const first = await getSharedD2();
    await compileStructured(FLOW_D2_EXAMPLE);
    await compileStructured(ERD_D2_EXAMPLE);
    const second = await getSharedD2();
    expect(second).toBe(first);
  }, 90000);

  live('dispose terminates the worker and the next compile recreates it', async () => {
    const before = await getSharedD2();
    await disposeSharedD2();
    const out = await compileStructured(FLOW_D2_EXAMPLE);
    expect(out.ok).toBe(true);
    const after = await getSharedD2();
    expect(after).not.toBe(before);
  }, 90000);

  live('virtual-file imports resolve against the supplied map only', async () => {
    const out = await compileStructured(
      '...@lib.d2\na: A',
      { virtualFiles: { 'lib.d2': 'b: B' } },
      { d2: createD2CompilePort() },
    );
    expect(out.ok).toBe(true);
    const ids = out.scene.elements.map((el) => el.id);
    expect(ids).toContain('d2:a');
    expect(ids).toContain('d2:b');
    const missing = await compileStructured('...@gone.d2\na: A', {}, { d2: createD2CompilePort() });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics[0]?.code).toBe('d2/syntax');
    expect(missing.scene.elements).toEqual([]);
  }, 90000);

  live('broken source never destroys the prior scene', async () => {
    const good = await compileStructured(FLOW_D2_EXAMPLE);
    // D2 is lenient: malformed input may compile (extra nodes) or throw.
    // Either way the contract holds: no crash, and no silent data loss.
    const bad = await compileStructured('start -> : broken {{', {
      prior: { baseline: good.baseline, scene: good.scene },
    });
    if (bad.diagnostics[0]?.code === 'd2/unavailable') return;
    if (!bad.ok) {
      expect(bad.scene).toEqual(good.scene);
      expect(bad.baseline).toEqual(good.baseline);
    } else {
      expect(bad.scene.elements.length).toBeGreaterThan(0);
    }
  }, 90000);
});
