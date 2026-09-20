import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Project } from '../core/models';

export interface ProjectIconDefinition {
  id: string;
  paths: string[];
}

/**
 * The fixed set of icons a project can use. Rendered as 24x24 stroke icons.
 */
export const PROJECT_ICONS: ProjectIconDefinition[] = [
  {
    id: 'folder',
    paths: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  },
  {
    id: 'code',
    paths: ['m8 6-6 6 6 6', 'm16 6 6 6-6 6'],
  },
  {
    id: 'terminal',
    paths: ['m4 17 6-5-6-5', 'M12 19h8'],
  },
  {
    id: 'rocket',
    paths: [
      'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
      'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
      'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0',
      'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
    ],
  },
  {
    id: 'star',
    paths: [
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
    ],
  },
  {
    id: 'bolt',
    paths: ['M13 2 3 14h9l-1 8 10-12h-9z'],
  },
  {
    id: 'bug',
    paths: [
      'm8 2 1.88 1.88',
      'M14.12 3.88 16 2',
      'M9 7.13v-1a3.003 3.003 0 1 1 6 0v1',
      'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6',
      'M12 20v-9',
      'M6.53 9C4.6 8.8 3 7.1 3 5',
      'M6 13H2',
      'M3 21c0-2.1 1.7-3.9 3.8-4',
      'M20.97 5c0 2.1-1.6 3.8-3.5 4',
      'M22 13h-4',
      'M17.2 17c2.1.1 3.8 1.9 3.8 4',
    ],
  },
  {
    id: 'book',
    paths: [
      'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
      'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    ],
  },
  {
    id: 'cube',
    paths: ['m21 16-9 5-9-5V8l9-5 9 5z', 'm3 8 9 5 9-5', 'M12 13v8'],
  },
  {
    id: 'flask',
    paths: ['M9 3h6', 'M10 3v6.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V3', 'M7 15h10'],
  },
  {
    id: 'heart',
    paths: [
      'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z',
    ],
  },
  {
    id: 'globe',
    paths: [
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    ],
  },
  {
    id: 'cloud',
    paths: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z'],
  },
  {
    id: 'gem',
    paths: ['M6 3h12l4 6-10 13L2 9z', 'M11 3 8 9l4 13 4-13-3-6', 'M2 9h20'],
  },
  {
    id: 'fire',
    paths: [
      'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z',
    ],
  },
  {
    id: 'leaf',
    paths: [
      'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z',
      'M2 21c0-3 1.85-5.36 5.08-6',
    ],
  },
];

export const PROJECT_COLORS = [
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#6366f1',
  '#3b82f6',
  '#06b6d4',
  '#14b8a6',
  '#10b981',
  '#84cc16',
  '#eab308',
  '#f97316',
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Stable accent color for a project, falling back to a hash of its identity. */
export function projectColor(project: Project): string {
  if (project.color) {
    return project.color;
  }
  const key = project.id || project.path || project.name;
  return PROJECT_COLORS[hashString(key) % PROJECT_COLORS.length];
}

/** Whether dark text reads better than white on the given hex color. */
export function projectColorIsLight(color: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) {
    return false;
  }
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62;
}

@Component({
  selector: 'app-project-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
    }
  `,
  template: `
    @if (project().iconImage) {
      <span
        class="inline-flex shrink-0 overflow-hidden border border-white/15 bg-white/5"
        [class]="radius()"
        [style.width.px]="size()"
        [style.height.px]="size()"
      >
        <img
          [src]="project().iconImage"
          alt=""
          class="h-full w-full object-cover"
          draggable="false"
        />
      </span>
    } @else {
      <span
        class="inline-flex shrink-0 items-center justify-center font-semibold leading-none"
        [class]="radius()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.background]="color()"
        [style.color]="textColor()"
        [style.font-size.px]="size() * 0.52"
      >
        @if (iconDefinition(); as definition) {
          <svg
            viewBox="0 0 24 24"
            [style.width.px]="size() * 0.6"
            [style.height.px]="size() * 0.6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            @for (path of definition.paths; track $index) {
              <path [attr.d]="path" />
            }
          </svg>
        } @else {
          <span>{{ initial() }}</span>
        }
      </span>
    }
  `,
})
export class ProjectIcon {
  readonly project = input.required<Project>();
  readonly size = input(20);
  readonly radius = input('rounded-md');

  protected readonly color = computed(() => projectColor(this.project()));
  protected readonly textColor = computed(() =>
    projectColorIsLight(this.color()) ? '#0b1220' : '#ffffff',
  );
  protected readonly initial = computed(() => {
    const name = this.project().name.trim();
    return name.length > 0 ? name[0].toUpperCase() : '?';
  });
  protected readonly iconDefinition = computed(() => {
    const id = this.project().icon;
    if (!id) {
      return null;
    }
    return PROJECT_ICONS.find((icon) => icon.id === id) ?? null;
  });
}
