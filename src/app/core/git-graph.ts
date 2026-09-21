import { GitCommit } from './models';

export const GIT_GRAPH_ROW_HEIGHT = 28;
export const GIT_GRAPH_LANE_WIDTH = 14;
export const GIT_GRAPH_MAX_LANES = 16;
export const GIT_GRAPH_RADIUS = 3.5;

const LANE_OFFSET = 8;

export const GIT_GRAPH_COLORS = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#ef4444',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#eab308',
  '#6366f1',
  '#f97316',
  '#22c55e',
  '#06b6d4',
];

export function gitLaneColor(lane: number): string {
  const count = GIT_GRAPH_COLORS.length;
  return GIT_GRAPH_COLORS[((lane % count) + count) % count];
}

export interface GitGraphPath {
  d: string;
  color: string;
}

export interface GitGraphRow {
  commit: GitCommit;
  nodeX: number;
  nodeColor: string;
  paths: GitGraphPath[];
}

export interface GitGraph {
  rows: GitGraphRow[];
  width: number;
}

interface Lane {
  hash: string | null;
  started: boolean;
}

interface LaneAssignment {
  commit: GitCommit;
  lane: number;
  before: Lane[];
  matched: number[];
  newLanes: number[];
}

/**
 * Builds a git graph (lanes, nodes and merge/fork edges) from a linear list of
 * commits ordered newest first.
 *
 * Branch tips are seeded in the given order (newest branch first) so the newest
 * branch always occupies the leftmost lane. A seeded lane draws nothing until
 * its tip commit appears. Each active lane "waits" for a parent hash; a commit
 * no lane expects starts a new lane, and extra parents of a merge open new
 * lanes. Merged lanes converge into the primary lane.
 */
export function buildGitGraph(commits: GitCommit[], tips: string[] = []): GitGraph {
  const lanes: Lane[] = [];
  const seeded = new Set<string>();
  for (const tip of tips) {
    if (!tip || seeded.has(tip)) {
      continue;
    }
    seeded.add(tip);
    lanes.push({ hash: tip, started: false });
  }

  const assignments: LaneAssignment[] = [];
  let maxLanes = Math.max(1, lanes.length);

  for (const commit of commits) {
    const before = lanes.map((lane) => ({ ...lane }));
    const matched: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index].hash === commit.hash) {
        matched.push(index);
      }
    }

    let lane: number;
    if (matched.length > 0) {
      lane = matched[0];
      lanes[lane].started = true;
    } else {
      lane = lanes.findIndex((entry) => entry.hash === null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push({ hash: null, started: false });
      }
    }

    const parents = commit.parents ?? [];
    for (let index = 1; index < matched.length; index += 1) {
      lanes[matched[index]] = { hash: null, started: false };
    }
    lanes[lane] = parents[0] ? { hash: parents[0], started: true } : { hash: null, started: false };

    const newLanes: number[] = [];
    for (let index = 1; index < parents.length; index += 1) {
      let slot = lanes.findIndex((entry) => entry.hash === null);
      if (slot === -1) {
        slot = lanes.length;
        lanes.push({ hash: null, started: false });
      }
      lanes[slot] = { hash: parents[index], started: true };
      newLanes.push(slot);
    }

    while (lanes.length > 0 && lanes[lanes.length - 1].hash === null) {
      lanes.pop();
    }

    maxLanes = Math.max(maxLanes, before.length, lane + 1, ...newLanes.map((entry) => entry + 1));
    assignments.push({ commit, lane, before, matched, newLanes });
  }

  const visibleLanes = Math.min(GIT_GRAPH_MAX_LANES, maxLanes);
  const width = LANE_OFFSET * 2 + visibleLanes * GIT_GRAPH_LANE_WIDTH;
  const laneX = (index: number): number =>
    LANE_OFFSET +
    Math.min(index, visibleLanes - 1) * GIT_GRAPH_LANE_WIDTH +
    GIT_GRAPH_LANE_WIDTH / 2;
  const centerY = GIT_GRAPH_ROW_HEIGHT / 2;

  const rows: GitGraphRow[] = assignments.map((assignment) => {
    const paths: GitGraphPath[] = [];
    const primaryX = laneX(assignment.lane);
    const primaryColor = gitLaneColor(assignment.lane);

    for (let index = 0; index < assignment.before.length; index += 1) {
      const lane = assignment.before[index];
      const isMatched = assignment.matched.includes(index);
      if (lane.hash === null || (!lane.started && !isMatched)) {
        continue;
      }
      const x = laneX(index);
      if (isMatched) {
        if (index === assignment.lane) {
          paths.push({ d: `M ${x} 0 L ${x} ${centerY}`, color: gitLaneColor(index) });
        } else {
          paths.push({
            d: `M ${x} 0 L ${primaryX} ${centerY}`,
            color: gitLaneColor(index),
          });
        }
      } else {
        paths.push({
          d: `M ${x} 0 L ${x} ${GIT_GRAPH_ROW_HEIGHT}`,
          color: gitLaneColor(index),
        });
      }
    }

    if ((assignment.commit.parents?.length ?? 0) > 0) {
      paths.push({
        d: `M ${primaryX} ${centerY} L ${primaryX} ${GIT_GRAPH_ROW_HEIGHT}`,
        color: primaryColor,
      });
    }

    for (const newLane of assignment.newLanes) {
      const targetX = laneX(newLane);
      paths.push({
        d: `M ${primaryX} ${centerY} L ${targetX} ${GIT_GRAPH_ROW_HEIGHT}`,
        color: gitLaneColor(newLane),
      });
    }

    return { commit: assignment.commit, nodeX: primaryX, nodeColor: primaryColor, paths };
  });

  return { rows, width };
}
