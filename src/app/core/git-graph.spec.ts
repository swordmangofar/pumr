import { describe, expect, it } from 'vitest';
import { GIT_GRAPH_MAX_LANES, buildGitGraph, linearGitGraph } from './git-graph';
import { GitCommit } from './models';

function commit(hash: string, parents: string[] = [], refs: string[] = []): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'Test',
    timestamp: 0,
    subject: `commit ${hash}`,
    refs,
    parents,
  };
}

describe('buildGitGraph', () => {
  it('keeps a linear history on a single lane', () => {
    const graph = buildGitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);
    const firstX = graph.rows[0].nodeX;
    expect(graph.rows.map((row) => row.nodeX)).toEqual([firstX, firstX, firstX]);
    expect(graph.width).toBeGreaterThan(0);
  });

  it('opens a second lane for a merge and converges at the base', () => {
    const graph = buildGitGraph([
      commit('m', ['p1', 'p2']),
      commit('p1', ['base']),
      commit('p2', ['base']),
      commit('base'),
    ]);
    expect(graph.rows[0].nodeX).not.toBe(graph.rows[2].nodeX);
    expect(graph.rows[0].paths.length).toBeGreaterThanOrEqual(2);
    expect(graph.rows[3].paths.length).toBeGreaterThanOrEqual(2);
  });

  it('starts a new lane for a commit no lane expects', () => {
    const graph = buildGitGraph([commit('a', ['x']), commit('b', ['y']), commit('x'), commit('y')]);
    expect(graph.rows[0].nodeX).not.toBe(graph.rows[1].nodeX);
  });

  it('seeds branch tips so the newest branch is leftmost', () => {
    const graph = buildGitGraph(
      [commit('newer', ['a']), commit('older', ['b']), commit('a'), commit('b')],
      ['newer', 'older'],
    );
    expect(graph.rows[0].nodeX).toBeLessThan(graph.rows[1].nodeX);
  });

  it('ignores branch tips that are not in the list', () => {
    const unlisted = Array.from({ length: 10 }, (_, index) => `old-${index}`);
    const graph = buildGitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')], unlisted);
    const single = buildGitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);
    expect(graph.rows.map((row) => row.nodeX)).toEqual(single.rows.map((row) => row.nodeX));
    expect(graph.width).toBe(single.width);
  });
});

describe('linearGitGraph', () => {
  it('keeps filtered commits on one lane regardless of their parents', () => {
    const commits = Array.from({ length: 30 }, (_, index) =>
      commit(`c${index}`, [`missing-parent-${index}`]),
    );
    const lanes = buildGitGraph(commits);
    const linear = linearGitGraph(commits);

    expect(lanes.width).toBeGreaterThan(linear.width);
    expect(new Set(lanes.rows.map((row) => row.nodeX)).size).toBe(GIT_GRAPH_MAX_LANES);
    expect(new Set(linear.rows.map((row) => row.nodeX)).size).toBe(1);
    expect(linear.rows[0].paths).toHaveLength(1);
    expect(linear.rows[29].paths).toHaveLength(1);
    expect(linear.rows[10].paths).toHaveLength(2);
  });
});
