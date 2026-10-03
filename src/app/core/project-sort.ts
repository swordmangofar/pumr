import { Project } from './models';

/** How the sidebar orders its projects. */
export type ProjectSort = 'activity' | 'name' | 'sessions';

export const PROJECT_SORTS: readonly ProjectSort[] = ['activity', 'name', 'sessions'];

export const DEFAULT_PROJECT_SORT: ProjectSort = 'name';

export function isProjectSort(value: unknown): value is ProjectSort {
  return PROJECT_SORTS.includes(value as ProjectSort);
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function byName(a: Project, b: Project): number {
  return NAME_COLLATOR.compare(a.name, b.name) || a.path.localeCompare(b.path);
}

/**
 * Returns `projects` in the order of `sort`, leaving the input untouched.
 * `lastActivity` is only asked for when sorting by activity. Projects that tie
 * fall back to their name so the order never depends on what the backend sent.
 */
export function sortProjects(
  projects: readonly Project[],
  sort: ProjectSort,
  lastActivity: (project: Project) => number,
): Project[] {
  if (sort === 'name') {
    return [...projects].sort(byName);
  }
  if (sort === 'sessions') {
    return [...projects].sort((a, b) => b.sessionCount - a.sessionCount || byName(a, b));
  }
  const activity = new Map(projects.map((project) => [project.id, lastActivity(project)]));
  return [...projects].sort(
    (a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || byName(a, b),
  );
}
