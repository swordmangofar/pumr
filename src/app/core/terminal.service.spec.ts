import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { Project } from './models';
import { TerminalService } from './terminal.service';
import { WorkspaceService } from './workspace.service';

describe('TerminalService', () => {
  const alpha = { id: 'alpha' } as Project;
  let activeProject: ReturnType<typeof signal<Project | null>>;
  let busy: ReturnType<typeof vi.spyOn>;
  let service: TerminalService;

  beforeEach(() => {
    localStorage.clear();
    activeProject = signal<Project | null>(alpha);
    busy = vi.spyOn(api, 'terminalBusy').mockResolvedValue(false);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            activeProject,
            projects: signal([alpha]),
            debugOpen: signal(false),
            focusedPanel: signal(null),
            setFocusedPanel: vi.fn(),
            requestComposerFocus: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(TerminalService);
  });

  afterEach(() => vi.restoreAllMocks());

  /** The tab titles of the active project, e.g. `[1, 2]`. */
  const numbers = () => service.projectTabs().map((tab) => tab.number);

  describe('running a command from the chat', () => {
    it('opens the dock with a terminal that takes the command', async () => {
      const requests = service.runRequest();

      await service.run('  git push -u origin main\n');

      expect(service.open()).toBe(true);
      expect(numbers()).toEqual([1]);
      expect(service.runRequest()).toBe(requests + 1);
      const key = service.activeKey()!;
      expect(service.takeCommands(key)).toEqual(['git push -u origin main']);
      // A command is handed over once.
      expect(service.takeCommands(key)).toEqual([]);
      // Nothing runs in a shell that has not started.
      expect(busy).not.toHaveBeenCalled();
    });

    it('goes to the terminal on show while its shell waits at the prompt', async () => {
      const key = service.create(alpha.id);
      service.started(key, 'shell-1');

      await service.run('ls');
      await service.run('pwd');

      expect(busy).toHaveBeenCalledWith('shell-1');
      expect(numbers()).toEqual([1]);
      expect(service.takeCommands(key)).toEqual(['ls', 'pwd']);
      expect(service.open()).toBe(true);
    });

    it('gets a terminal of its own while a program runs in the one on show', async () => {
      const first = service.create(alpha.id);
      service.started(first, 'shell-1');
      busy.mockResolvedValue(true);

      await service.run('ls');

      expect(numbers()).toEqual([1, 2]);
      expect(service.activeKey()).not.toBe(first);
      expect(service.takeCommands(first)).toEqual([]);
      expect(service.takeCommands(service.activeKey()!)).toEqual(['ls']);
    });

    it('gets a terminal of its own when the shell on show has ended', async () => {
      const first = service.create(alpha.id);
      service.started(first, 'shell-1');
      service.exited(first, 1);

      await service.run('ls');

      expect(busy).not.toHaveBeenCalled();
      expect(numbers()).toEqual([1, 2]);
      expect(service.takeCommands(service.activeKey()!)).toEqual(['ls']);
    });

    it('gets a terminal of its own when the backend no longer knows the shell', async () => {
      const first = service.create(alpha.id);
      service.started(first, 'shell-1');
      busy.mockRejectedValue('Unknown terminal: shell-1');

      await service.run('ls');

      expect(numbers()).toEqual([1, 2]);
      expect(service.takeCommands(first)).toEqual([]);
    });

    it('drops the commands of a terminal that is closed', async () => {
      const first = service.create(alpha.id);
      service.create(alpha.id);
      service.activate(first);
      await service.run('ls');

      service.close(first);

      expect(service.takeCommands(first)).toEqual([]);
    });

    it('does nothing without a command or a project', async () => {
      await service.run('  \n');
      activeProject.set(null);
      await service.run('ls');

      expect(service.open()).toBe(false);
      expect(service.tabs()).toEqual([]);
    });
  });
});
