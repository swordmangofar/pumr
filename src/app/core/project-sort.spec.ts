import { describe, expect, it } from 'vitest';
import { Project } from './models';
import { isProjectSort, sortProjects } from './project-sort';

function project(name: string, patch: Partial<Project> = {}): Project {
  return {
    id: name,
    path: `/code/${name}`,
    name,
    createdAt: 0,
    lastOpenedAt: 0,
    sessionCount: 0,
    totalCost: 0,
    color: null,
    icon: null,
    iconImage: null,
    ...patch,
  };
}

function names(projects: Project[]): string[] {
  return projects.map((entry) => entry.name);
}

describe('sortProjects', () => {
  it('sorts by name without regard to case and with numbers in order', () => {
    const projects = [project('zeta'), project('app10'), project('Beta'), project('app2')];

    expect(names(sortProjects(projects, 'name', () => 0))).toEqual([
      'app2',
      'app10',
      'Beta',
      'zeta',
    ]);
  });

  it('puts the project with the most sessions first and breaks ties by name', () => {
    const projects = [
      project('small', { sessionCount: 1 }),
      project('busy', { sessionCount: 9 }),
      project('also-small', { sessionCount: 1 }),
    ];

    expect(names(sortProjects(projects, 'sessions', () => 0))).toEqual([
      'busy',
      'also-small',
      'small',
    ]);
  });

  it('puts the most recently active project first and breaks ties by name', () => {
    const activity: Record<string, number> = { old: 10, fresh: 30, idle: 10 };
    const projects = [project('old'), project('fresh'), project('idle')];

    expect(names(sortProjects(projects, 'activity', (entry) => activity[entry.id]))).toEqual([
      'fresh',
      'idle',
      'old',
    ]);
  });

  it('leaves the input order untouched', () => {
    const projects = [project('b'), project('a')];

    sortProjects(projects, 'name', () => 0);

    expect(names(projects)).toEqual(['b', 'a']);
  });
});

describe('isProjectSort', () => {
  it('accepts only known sort modes', () => {
    expect(isProjectSort('activity')).toBe(true);
    expect(isProjectSort('name')).toBe(true);
    expect(isProjectSort('sessions')).toBe(true);
    expect(isProjectSort('random')).toBe(false);
    expect(isProjectSort(null)).toBe(false);
  });
});
