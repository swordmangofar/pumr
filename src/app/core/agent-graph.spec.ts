import { describe, expect, it } from 'vitest';
import { AGENT_GRAPH_ROW_HEIGHT, buildAgentGraph } from './agent-graph';

function node(
  id: string,
  at: number | null,
  extra: { taskCallIds?: string[]; toolCallId?: string | null } = {},
) {
  return {
    id,
    at,
    phase: at === null ? (0 as const) : (1 as const),
    taskCallIds: extra.taskCallIds ?? [],
    toolCallId: extra.toolCallId ?? null,
  };
}

function session(
  id: string,
  parentSessionId: string | null,
  createdAt: number,
  nodes: ReturnType<typeof node>[],
  status: string | null = 'done',
) {
  return { id, parentSessionId, title: id, status, createdAt, nodes };
}

describe('buildAgentGraph', () => {
  it('keeps a main session on a single lane', () => {
    const root = session('root', null, 0, [node('a', null), node('b', 10)]);
    const graph = buildAgentGraph([root], 'root');
    expect(graph.rows).toHaveLength(2);
    expect(graph.rows.every((row) => row.lane === 0)).toBe(true);
  });

  it('forks a subagent onto its own lane and merges it back', () => {
    const root = session('root', null, 0, [
      node('r1', null),
      node('r2', 100, { taskCallIds: ['call1'] }),
      node('r3', 200, { toolCallId: 'call1' }),
    ]);
    const child = session('child', 'root', 100, [node('c1', 110), node('c2', 150)]);
    const graph = buildAgentGraph([root, child], 'root');

    expect(graph.rows.map((row) => row.id)).toEqual(['r1', 'r2', 'c1', 'c2', 'r3']);
    expect(graph.rows[1].lane).toBe(0);
    expect(graph.rows[2].lane).toBe(1);
    expect(graph.rows[3].lane).toBe(1);
    expect(graph.rows[4].lane).toBe(0);
    expect(graph.rows[2].branchStart).toBe(true);
    expect(
      graph.rows[4].paths.some((path) => path.d.startsWith('M') && path.d.includes(' L ')),
    ).toBe(true);
    expect(graph.width).toBeGreaterThan(0);
  });

  it('gives parallel subagents distinct lanes', () => {
    const root = session('root', null, 0, [
      node('r1', 100, { taskCallIds: ['call1', 'call2'] }),
      node('r2', 200, { toolCallId: 'call1' }),
      node('r3', 210, { toolCallId: 'call2' }),
    ]);
    const first = session('first', 'root', 100, [node('f1', 110)]);
    const second = session('second', 'root', 105, [node('s1', 120)]);
    const graph = buildAgentGraph([root, first, second], 'root');

    const lanes = new Map(graph.rows.map((row) => [row.id, row.lane]));
    expect(lanes.get('f1')).toBe(1);
    expect(lanes.get('s1')).toBe(2);
    expect(lanes.get('r1')).toBe(0);
    const x = new Map(graph.rows.map((row) => [row.id, row.nodeX]));
    expect(x.get('r1')).toBeLessThan(x.get('f1') as number);
    expect(x.get('f1')).toBeLessThan(x.get('s1') as number);
  });

  it('marks an unmerged running branch as open', () => {
    const root = session('root', null, 0, [node('r1', 100, { taskCallIds: ['call1'] })]);
    const child = session('child', 'root', 100, [node('c1', 110)], 'running');
    const graph = buildAgentGraph([root, child], 'root');
    expect(graph.rows[graph.rows.length - 1].open).toBe(true);
  });

  it('forks a resumed subagent from its parent lane and closes it when settled', () => {
    const center = AGENT_GRAPH_ROW_HEIGHT / 2;
    const root = session('root', null, 0, [
      node('r1', 100, { taskCallIds: ['call1'] }),
      node('r2', 200, { toolCallId: 'call1' }),
      node('r3', 300),
    ]);
    const child = session('child', 'root', 100, [node('c1', 110), node('c2', 250)]);
    const graph = buildAgentGraph([root, child], 'root');
    const rootX = graph.rows.find((row) => row.id === 'r1')?.nodeX as number;
    const resumed = graph.rows.find((row) => row.id === 'c2') as (typeof graph.rows)[number];

    expect(resumed.lane).toBe(1);
    expect(resumed.branchStart).toBe(true);
    expect(resumed.open).toBe(false);
    expect(
      resumed.paths.some((path) => path.d === `M ${rootX} ${center} L ${resumed.nodeX} ${center}`),
    ).toBe(true);
    expect(
      resumed.paths.some(
        (path) =>
          path.d ===
          `M ${resumed.nodeX} ${center} L ${resumed.nodeX} ${AGENT_GRAPH_ROW_HEIGHT + 1}`,
      ),
    ).toBe(false);
  });

  it('keeps a resumed subagent branch open while it runs', () => {
    const root = session('root', null, 0, [
      node('r1', 100, { taskCallIds: ['call1'] }),
      node('r2', 200, { toolCallId: 'call1' }),
    ]);
    const child = session('child', 'root', 100, [node('c1', 110), node('c2', 250)], 'running');
    const graph = buildAgentGraph([root, child], 'root');
    const resumed = graph.rows.find((row) => row.id === 'c2');
    expect(resumed?.open).toBe(true);
    expect(resumed?.branchStart).toBe(true);
  });
});
