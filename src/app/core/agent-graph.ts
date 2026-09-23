export const AGENT_GRAPH_ROW_HEIGHT = 30;
export const AGENT_GRAPH_LANE_WIDTH = 16;
export const AGENT_GRAPH_MAX_LANES = 12;
export const AGENT_GRAPH_RADIUS = 4;

const LANE_OFFSET = 9;

export const AGENT_GRAPH_COLORS = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#6366f1',
  '#f97316',
  '#22c55e',
  '#06b6d4',
  '#eab308',
  '#ef4444',
];

export function agentLaneColor(lane: number): string {
  const count = AGENT_GRAPH_COLORS.length;
  return AGENT_GRAPH_COLORS[((lane % count) + count) % count];
}

export interface AgentGraphNode {
  id: string;
  at: number | null;
  /** 0 = ordered before timed rows (context), 1 = timed, 2 = after (live/pending). */
  phase: 0 | 1 | 2;
  /** Task tool-call ids issued by this node; each spawns a child branch. */
  taskCallIds: string[];
  /** Tool-call id this node answers, used to merge a spawned branch back. */
  toolCallId: string | null;
}

export interface AgentGraphSession {
  id: string;
  parentSessionId: string | null;
  title: string;
  status: string | null;
  createdAt: number;
  nodes: AgentGraphNode[];
}

export interface AgentGraphEdge {
  d: string;
  color: string;
}

export interface AgentGraphRow {
  /** Caller-supplied node id; must be globally unique across sessions. */
  id: string;
  sessionId: string;
  lane: number;
  nodeX: number;
  nodeColor: string;
  paths: AgentGraphEdge[];
  /** First row belonging to this session (labels the branch). */
  branchStart: boolean;
  /** Branch never merged back and has no further nodes (e.g. still running). */
  open: boolean;
}

export interface AgentGraph {
  rows: AgentGraphRow[];
  width: number;
}

interface OrderedNode extends AgentGraphNode {
  sessionId: string;
  seq: number;
}

/**
 * Builds a branch/merge lane graph for a main session and its subagents, similar
 * to a git graph. The main agent owns lane 0; every subagent forks off its parent
 * at the `task` call that spawned it and merges back at the tool result that
 * carries the subagent report. Nodes are laid out chronologically across lanes so
 * parallel subagents share the timeline.
 */
export function buildAgentGraph(sessions: AgentGraphSession[], rootSessionId: string): AgentGraph {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const root =
    byId.get(rootSessionId) ??
    sessions.find((session) => session.parentSessionId === null) ??
    sessions[0];
  if (!root) {
    return { rows: [], width: 0 };
  }

  const childrenOf = new Map<string, AgentGraphSession[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) {
      continue;
    }
    const list = childrenOf.get(session.parentSessionId) ?? [];
    list.push(session);
    childrenOf.set(session.parentSessionId, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }

  const callChild = pairTaskCalls(sessions, childrenOf);

  const ordered: OrderedNode[] = [];
  sessions.forEach((session, sessionIndex) => {
    session.nodes.forEach((node, nodeIndex) => {
      ordered.push({
        ...node,
        sessionId: session.id,
        seq: sessionIndex * 100000 + nodeIndex,
      });
    });
  });
  ordered.sort((a, b) => {
    if (a.phase !== b.phase) {
      return a.phase - b.phase;
    }
    const atA = a.at ?? -1;
    const atB = b.at ?? -1;
    if (atA !== atB) {
      return atA - atB;
    }
    return a.seq - b.seq;
  });

  const laneOf = new Map<string, number>([[root.id, 0]]);
  const active: boolean[] = [true];
  let laneCount = 1;
  const allocate = (): number => {
    const lane = laneCount;
    laneCount += 1;
    return lane;
  };

  const lastNodeOf = new Map<string, string>();
  for (const session of sessions) {
    if (session.nodes.length > 0) {
      lastNodeOf.set(session.id, session.nodes[session.nodes.length - 1].id);
    }
  }
  const merged = new Set<string>();
  const seen = new Set<string>();

  // A branch's merge point is the parent's task result for the call that spawned
  // it. Without one (e.g. a subagent resumed directly in its own chat) the branch
  // has to close itself when it goes idle.
  const callForChild = new Map<string, string>();
  for (const [callId, childId] of callChild) {
    callForChild.set(childId, callId);
  }
  const resultCallIds = new Set<string>();
  for (const session of sessions) {
    for (const node of session.nodes) {
      if (node.toolCallId) {
        resultCallIds.add(node.toolCallId);
      }
    }
  }

  interface PendingRow {
    node: OrderedNode;
    session: AgentGraphSession;
    lane: number;
    branchStart: boolean;
    mergeFrom: number[];
    forkTo: number[];
    resumeFrom: number | null;
    selfMergeTo: number | null;
    before: boolean[];
    after: boolean[];
    open: boolean;
  }

  const pending: PendingRow[] = [];
  for (const node of ordered) {
    const session = byId.get(node.sessionId);
    if (!session) {
      continue;
    }
    const isRoot = session.id === root.id;
    let lane = laneOf.get(session.id);
    const wasActive = lane !== undefined && active[lane] === true;
    let branchStart = false;
    if (lane === undefined) {
      lane = allocate();
      laneOf.set(session.id, lane);
      branchStart = true;
    } else if (!seen.has(session.id)) {
      branchStart = true;
    } else if (!wasActive) {
      branchStart = true;
    }
    seen.add(session.id);

    const before = active.slice();
    active[lane] = true;

    // A lane that was idle (first appearance without a task fork, or a subagent
    // resumed after it already merged) forks afresh from its parent's lane.
    let resumeFrom: number | null = null;
    if (!isRoot && !wasActive) {
      const parentLane = laneOf.get(session.parentSessionId ?? '') ?? 0;
      resumeFrom = before[parentLane] ? parentLane : 0;
      if (resumeFrom === lane) {
        resumeFrom = null;
      }
    }

    const mergeFrom: number[] = [];
    if (node.toolCallId) {
      const childId = callChild.get(node.toolCallId);
      const childLane = childId ? laneOf.get(childId) : undefined;
      if (childLane !== undefined && active[childLane]) {
        mergeFrom.push(childLane);
        active[childLane] = false;
        if (childId) {
          merged.add(childId);
        }
      }
    }

    const forkTo: number[] = [];
    for (const callId of node.taskCallIds) {
      const childId = callChild.get(callId);
      if (!childId) {
        continue;
      }
      const existing = laneOf.get(childId);
      const childLane = existing ?? allocate();
      if (existing === undefined) {
        laneOf.set(childId, childLane);
      }
      active[childLane] = true;
      forkTo.push(childLane);
    }

    const isLast = lastNodeOf.get(session.id) === node.id;
    let selfMergeTo: number | null = null;
    if (!isRoot && isLast) {
      const callId = callForChild.get(session.id);
      const hasResult = callId ? resultCallIds.has(callId) : false;
      // Close the branch here when it is settled and no task result is still
      // pending: either none will ever arrive, or it already merged once and was
      // resumed directly (so a later segment has no parent result of its own).
      const pendingResult = hasResult && !merged.has(session.id);
      if (!pendingResult && session.status !== 'running' && active[lane]) {
        const parentLane = laneOf.get(session.parentSessionId ?? '') ?? 0;
        if (parentLane !== lane) {
          selfMergeTo = parentLane;
          active[lane] = false;
          merged.add(session.id);
        }
      }
    }

    const after = active.slice();
    pending.push({
      node,
      session,
      lane,
      branchStart,
      mergeFrom,
      forkTo,
      resumeFrom,
      selfMergeTo,
      before,
      after,
      open: !isRoot && isLast && after[lane] === true,
    });
  }

  const visibleLanes = Math.min(AGENT_GRAPH_MAX_LANES, Math.max(1, laneCount));
  const laneX = (lane: number): number =>
    LANE_OFFSET +
    Math.min(lane, visibleLanes - 1) * AGENT_GRAPH_LANE_WIDTH +
    AGENT_GRAPH_LANE_WIDTH / 2;
  const centerY = AGENT_GRAPH_ROW_HEIGHT / 2;

  const rows: AgentGraphRow[] = pending.map((row) => {
    const primaryX = laneX(row.lane);
    const mergeSet = new Set(row.mergeFrom);
    const forkSet = new Set(row.forkTo);
    const paths: AgentGraphEdge[] = [];
    for (let index = 0; index < row.before.length; index += 1) {
      if (!row.before[index]) {
        continue;
      }
      const x = laneX(index);
      if (mergeSet.has(index)) {
        paths.push({ d: `M ${x} -1 L ${primaryX} ${centerY}`, color: agentLaneColor(index) });
      } else {
        paths.push({ d: `M ${x} -1 L ${x} ${centerY}`, color: agentLaneColor(index) });
      }
    }
    for (let index = 0; index < row.after.length; index += 1) {
      if (!row.after[index]) {
        continue;
      }
      const x = laneX(index);
      if (forkSet.has(index)) {
        paths.push({
          d: `M ${primaryX} ${centerY} L ${x} ${AGENT_GRAPH_ROW_HEIGHT + 1}`,
          color: agentLaneColor(index),
        });
      } else {
        paths.push({
          d: `M ${x} ${centerY} L ${x} ${AGENT_GRAPH_ROW_HEIGHT + 1}`,
          color: agentLaneColor(index),
        });
      }
    }
    if (row.resumeFrom !== null) {
      paths.push({
        d: `M ${laneX(row.resumeFrom)} ${centerY} L ${primaryX} ${centerY}`,
        color: agentLaneColor(row.lane),
      });
    }
    if (row.selfMergeTo !== null) {
      paths.push({
        d: `M ${primaryX} ${centerY} L ${laneX(row.selfMergeTo)} ${centerY}`,
        color: agentLaneColor(row.lane),
      });
    }
    return {
      id: row.node.id,
      sessionId: row.session.id,
      lane: row.lane,
      nodeX: primaryX,
      nodeColor: agentLaneColor(row.lane),
      paths,
      branchStart: row.branchStart,
      open: row.open,
    };
  });

  return { rows, width: LANE_OFFSET * 2 + visibleLanes * AGENT_GRAPH_LANE_WIDTH };
}

/**
 * Pairs each parent's task tool-call ids (in chronological order) with its child
 * sessions (in creation order). The subagent session does not persist the call id
 * that spawned it, so the spawn order is the join key.
 */
function pairTaskCalls(
  sessions: AgentGraphSession[],
  childrenOf: Map<string, AgentGraphSession[]>,
): Map<string, string> {
  const callChild = new Map<string, string>();
  for (const parent of sessions) {
    const children = childrenOf.get(parent.id) ?? [];
    if (children.length === 0) {
      continue;
    }
    const calls: string[] = [];
    for (const node of parent.nodes) {
      calls.push(...node.taskCallIds);
    }
    const count = Math.min(calls.length, children.length);
    for (let index = 0; index < count; index += 1) {
      callChild.set(calls[index], children[index].id);
    }
  }
  return callChild;
}
