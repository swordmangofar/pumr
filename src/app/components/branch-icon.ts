import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The mark in front of a git branch name: a trunk, a branch off it and the
 * curve that joins them. The `⎇` character it replaces is drawn by few fonts
 * and illegibly at text size. It takes the colour of the text beside it; the
 * host class sets its size.
 */
@Component({
  selector: 'app-branch-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block h-3.5 w-3.5 shrink-0' },
  template: `
    <svg
      viewBox="0 0 24 24"
      class="h-full w-full"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  `,
})
export class BranchIcon {}
