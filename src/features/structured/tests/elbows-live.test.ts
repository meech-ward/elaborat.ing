import { afterAll, expect, test } from 'bun:test';
import { buildCompileRequest, createD2CompilePort, disposeSharedD2, getSharedD2 } from '../compiler';
import { emitNativeScene } from '../emitter';
import { FLOW_D2_EXAMPLE, ERD_D2_EXAMPLE, CLOUD_D2_EXAMPLE } from '../examples';

const live = test.if(process.env.STRUCTURED_ELBOW_LIVE === '1');
const examples = { flow: FLOW_D2_EXAMPLE, erd: ERD_D2_EXAMPLE, cloud: CLOUD_D2_EXAMPLE };
const orthogonal = (points: readonly { x: number; y: number }[]) => points.length >= 2 && points.slice(1).every((point, index) => Math.abs(point.x - points[index].x) < 0.01 || Math.abs(point.y - points[index].y) < 0.01);

live('generated flow, ERD and cloud connectors have real orthogonal routes and native elbow bindings', async () => {
  const failures: string[] = [];
  for (const [name, source] of Object.entries(examples)) {
    const diagram = await createD2CompilePort()({ source });
    const emitted = emitNativeScene(diagram);
    const routes = (diagram.connections ?? []).map((edge) => ({ id: edge.id, route: edge.route, orthogonal: orthogonal(edge.route ?? []) }));
    console.log(JSON.stringify({ name, routes }));
    const arrows = emitted.elements.filter((element) => element.type === 'arrow');
    for (const arrow of arrows) {
      if (arrow.elbowed !== true) failures.push(`${name}:${arrow.id} not a native elbow`);
      if (!orthogonal((arrow.points as number[][]).map(([x, y]) => ({ x, y })))) failures.push(`${name}:${arrow.id} non-orthogonal native route`);
      for (const binding of [arrow.startBinding, arrow.endBinding]) {
        if (binding && !(binding as { fixedPoint?: unknown }).fixedPoint) failures.push(`${name}:${arrow.id} missing native fixed-point binding`);
      }
    }
    expect(arrows.length).toBe(routes.length);
    expect(arrows.length).toBeGreaterThan(0);
  }
  expect(failures).toEqual([]);
}, 60000);

live('the pinned D2 ELK option yields polyline routes rather than Bezier controls', async () => {
  const compiler = await getSharedD2();
  for (const [name, source] of Object.entries(examples)) {
    const result = await compiler.compile({ ...buildCompileRequest(source), options: { layout: 'elk' } });
    const routes = (result.diagram.connections ?? []).map((edge) => ({ id: edge.id, src: edge.src, dst: edge.dst, route: edge.route, isCurve: (edge as { isCurve?: boolean }).isCurve, orthogonal: orthogonal(edge.route ?? []) }));
    console.log(JSON.stringify({ engine: 'elk', name, shapes: result.diagram.shapes, routes }));
    expect(routes.every((edge) => !edge.isCurve)).toBe(true);
  }
}, 60000);

afterAll(disposeSharedD2);
