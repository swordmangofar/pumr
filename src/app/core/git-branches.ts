import { GitBranch } from './models';

export interface GitBranchFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: GitBranchTreeNode[];
}

export interface GitBranchLeaf {
  kind: 'branch';
  name: string;
  path: string;
  branch: GitBranch;
}

export type GitBranchTreeNode = GitBranchFolder | GitBranchLeaf;

export interface GitBranchTreeRow {
  kind: 'folder' | 'branch';
  name: string;
  path: string;
  depth: number;
  branch?: GitBranch;
}

export function buildBranchTree(branches: GitBranch[]): GitBranchTreeNode[] {
  const root: GitBranchFolder = { kind: 'folder', name: '', path: '', children: [] };
  const folders = new Map<string, GitBranchFolder>([['', root]]);
  const sorted = [...branches].sort((a, b) => a.name.localeCompare(b.name));
  for (const branch of sorted) {
    const segments = branch.name.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      continue;
    }
    let parent = root;
    let current = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      current = current ? `${current}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        parent.children.push({ kind: 'branch', name: segment, path: current, branch });
      } else {
        let node = folders.get(current);
        if (!node) {
          node = { kind: 'folder', name: segment, path: current, children: [] };
          folders.set(current, node);
          parent.children.push(node);
        }
        parent = node;
      }
    }
  }
  sortBranchTree(root.children);
  return root.children;
}

function sortBranchTree(nodes: GitBranchTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'folder') {
      sortBranchTree(node.children);
    }
  }
}

export function flattenBranchTree(
  nodes: GitBranchTreeNode[],
  collapsed: ReadonlySet<string>,
): GitBranchTreeRow[] {
  const rows: GitBranchTreeRow[] = [];
  const walk = (items: GitBranchTreeNode[], depth: number): void => {
    for (const node of items) {
      if (node.kind === 'folder') {
        rows.push({ kind: 'folder', name: node.name, path: node.path, depth });
        if (!collapsed.has(node.path)) {
          walk(node.children, depth + 1);
        }
      } else {
        rows.push({ kind: 'branch', name: node.name, path: node.path, depth, branch: node.branch });
      }
    }
  };
  walk(nodes, 0);
  return rows;
}
