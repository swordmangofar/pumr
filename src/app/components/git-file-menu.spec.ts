import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../core/git.service';
import { WorkspaceEditorService } from '../core/workspace-editor.service';
import { WorkspaceService } from '../core/workspace.service';
import { GitFileMenu } from './git-file-menu';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string, params?: { count?: number }): string {
    return params?.count === undefined ? value : `${value} ${params.count}`;
  }
}

interface MenuInputs {
  path: string;
  paths?: string[];
  staged: boolean;
  conflicted?: boolean;
  conflictedPaths?: string[];
}

describe('GitFileMenu', () => {
  let fixture: ComponentFixture<GitFileMenu>;
  let closed: Mock<() => void>;
  const git = {
    stagePath: vi.fn(),
    stagePaths: vi.fn(),
    unstagePath: vi.fn(),
    unstagePaths: vi.fn(),
    confirmResolving: vi.fn(),
  };

  beforeEach(() => {
    for (const method of Object.values(git)) {
      method.mockReset().mockResolvedValue(undefined);
    }
    git.confirmResolving.mockResolvedValue(true);
  });

  function open(inputs: MenuInputs): void {
    TestBed.configureTestingModule({
      providers: [
        { provide: GitService, useValue: git },
        { provide: WorkspaceService, useValue: { browseProject: signal({ id: 'p1' }) } },
        { provide: WorkspaceEditorService, useValue: {} },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
      ],
    });
    TestBed.overrideComponent(GitFileMenu, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(GitFileMenu);
    fixture.componentRef.setInput('path', inputs.path);
    fixture.componentRef.setInput('paths', inputs.paths ?? [inputs.path]);
    fixture.componentRef.setInput('staged', inputs.staged);
    fixture.componentRef.setInput('conflicted', inputs.conflicted ?? false);
    fixture.componentRef.setInput('conflictedPaths', new Set(inputs.conflictedPaths ?? []));
    fixture.componentRef.setInput('x', 10);
    fixture.componentRef.setInput('y', 10);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
  }

  function items(): string[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.menu-item')].map(
      (item) => item.textContent?.trim() ?? '',
    );
  }

  async function choose(text: string): Promise<void> {
    const item = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.menu-item')].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    if (!item) {
      throw new Error(`no menu item "${text}" among ${items().join(', ')}`);
    }
    (item as HTMLButtonElement).click();
    // Staging first waits for the answer about conflict markers.
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  describe('unstaging', () => {
    it('unstages the staged file it was opened on', async () => {
      open({ path: 'a.txt', staged: true });

      await choose('git.unstage 1');

      expect(git.unstagePath).toHaveBeenCalledWith('p1', 'a.txt');
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('is not offered for a conflicted file, which is resolved instead', () => {
      open({
        path: 'shared.txt',
        staged: true,
        conflicted: true,
        conflictedPaths: ['shared.txt'],
      });

      expect(items().slice(0, 4)).toEqual([
        'git.conflict.useOurs',
        'git.conflict.useTheirs',
        'git.conflict.markResolved',
        'git.blame',
      ]);
    });

    it('leaves the conflicted files of a selection out', async () => {
      open({
        path: 'shared.txt',
        paths: ['a.txt', 'shared.txt', 'b.txt'],
        staged: true,
        conflicted: true,
        conflictedPaths: ['shared.txt'],
      });

      await choose('git.unstageSelected 2');

      expect(git.unstagePaths).toHaveBeenCalledWith('p1', ['a.txt', 'b.txt']);
      expect(git.unstagePath).not.toHaveBeenCalled();
    });

    it('unstages the one file of a selection that is not conflicted by itself', async () => {
      open({
        path: 'a.txt',
        paths: ['a.txt', 'shared.txt'],
        staged: true,
        conflictedPaths: ['shared.txt'],
      });

      await choose('git.unstage 1');

      expect(git.unstagePath).toHaveBeenCalledWith('p1', 'a.txt');
      expect(git.unstagePaths).not.toHaveBeenCalled();
    });
  });

  describe('staging', () => {
    it('marks a conflict resolved once leftover conflict markers were accepted', async () => {
      open({ path: 'shared.txt', staged: false, conflicted: true, conflictedPaths: ['shared.txt'] });

      await choose('git.conflict.markResolved');

      expect(git.confirmResolving).toHaveBeenCalledWith('p1', ['shared.txt']);
      expect(git.stagePath).toHaveBeenCalledWith('p1', 'shared.txt');
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('leaves a conflict open when the question about its markers is declined', async () => {
      git.confirmResolving.mockResolvedValue(false);
      open({ path: 'shared.txt', staged: false, conflicted: true, conflictedPaths: ['shared.txt'] });

      await choose('git.conflict.markResolved');

      expect(git.stagePath).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('asks the same before a selection with a conflicted file is staged', async () => {
      git.confirmResolving.mockResolvedValue(false);
      open({ path: 'a.txt', paths: ['a.txt', 'shared.txt'], staged: false });

      await choose('git.stageSelected 2');
      expect(git.confirmResolving).toHaveBeenCalledWith('p1', ['a.txt', 'shared.txt']);
      expect(git.stagePaths).not.toHaveBeenCalled();

      git.confirmResolving.mockResolvedValue(true);
      await choose('git.stageSelected 2');
      expect(git.stagePaths).toHaveBeenCalledWith('p1', ['a.txt', 'shared.txt']);
    });
  });
});
