import { describe, expect, it } from 'vitest';
import { buildBranchTree, flattenBranchTree } from './git-branches';
import { GitBranch } from './models';

function branch(name: string, remote = false): GitBranch {
  return {
    name,
    current: false,
    remote,
    upstream: null,
    hash: null,
    subject: null,
    timestamp: null,
  };
}

describe('buildBranchTree', () => {
  it('groups branches that share a path into folders', () => {
    const tree = buildBranchTree([branch('origin/10.0.X', true), branch('origin/11.0.X', true)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('folder');
    expect(tree[0].name).toBe('origin');
    if (tree[0].kind === 'folder') {
      expect(tree[0].children.map((child) => child.name)).toEqual(['10.0.X', '11.0.X']);
    }
  });

  it('nests subfolders and subsubfolders', () => {
    const tree = buildBranchTree([branch('origin/feature/ui/button', true)]);
    const origin = tree[0];
    expect(origin.kind).toBe('folder');
    if (origin.kind === 'folder') {
      const feature = origin.children[0];
      expect(feature.kind).toBe('folder');
      if (feature.kind === 'folder') {
        const ui = feature.children[0];
        expect(ui.kind).toBe('folder');
        if (ui.kind === 'folder') {
          expect(ui.children[0].name).toBe('button');
        }
      }
    }
  });

  it('sorts folders before branches and alphabetically', () => {
    const tree = buildBranchTree([branch('main'), branch('origin/main', true)]);
    expect(tree.map((node) => node.name)).toEqual(['origin', 'main']);
  });

  it('keeps branches without slashes at the root', () => {
    const tree = buildBranchTree([branch('main'), branch('develop')]);
    expect(tree.map((node) => node.kind)).toEqual(['branch', 'branch']);
  });
});

describe('flattenBranchTree', () => {
  it('omits children of collapsed folders', () => {
    const tree = buildBranchTree([branch('origin/10.0.X', true), branch('origin/11.0.X', true)]);
    const collapsed = new Set(['origin']);
    const rows = flattenBranchTree(tree, collapsed);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('folder');
    expect(rows[0].depth).toBe(0);
  });

  it('assigns increasing depth to nested rows', () => {
    const tree = buildBranchTree([branch('origin/feature/ui/button', true)]);
    const rows = flattenBranchTree(tree, new Set());
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3]);
    expect(rows[rows.length - 1].kind).toBe('branch');
  });
});
