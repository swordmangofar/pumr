import { Pipe, PipeTransform } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { describe, expect, it, vi } from 'vitest';
import { GitStashDialog } from './git-stash-dialog';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

async function create(submit: unknown): Promise<ComponentFixture<GitStashDialog>> {
  TestBed.overrideComponent(GitStashDialog, {
    remove: { imports: [TranslocoPipe] },
    add: { imports: [StubTranslocoPipe] },
  });
  const fixture = TestBed.createComponent(GitStashDialog);
  fixture.componentRef.setInput('submit', submit);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function buttons(fixture: ComponentFixture<GitStashDialog>): HTMLButtonElement[] {
  return [...fixture.nativeElement.querySelectorAll('footer button')];
}

function type(fixture: ComponentFixture<GitStashDialog>, value: string): void {
  const input: HTMLInputElement = fixture.nativeElement.querySelector('#git-stash-dialog-message');
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function untracked(fixture: ComponentFixture<GitStashDialog>): HTMLInputElement {
  return fixture.nativeElement.querySelector('input[type="checkbox"]');
}

describe('GitStashDialog', () => {
  it('stashes with untracked files and no message unless told otherwise', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create(submit);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    expect(untracked(fixture).checked).toBe(true);

    buttons(fixture)[1].click();
    await fixture.whenStable();

    expect(submit).toHaveBeenCalledWith({ message: '', includeUntracked: true });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('passes the trimmed message and the untracked choice on', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create(submit);

    type(fixture, '  half done  ');
    untracked(fixture).click();
    fixture.detectChanges();
    buttons(fixture)[1].click();
    await fixture.whenStable();

    expect(submit).toHaveBeenCalledWith({ message: 'half done', includeUntracked: false });
  });

  it('stays open and shows the error when stashing fails', async () => {
    const submit = vi.fn().mockRejectedValue('error: could not write index');
    const fixture = await create(submit);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    buttons(fixture)[1].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(closed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('could not write index');
    expect(buttons(fixture)[1].disabled).toBe(false);
  });

  it('cannot be closed while a stash is running', async () => {
    let finish: () => void = () => undefined;
    const submit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const fixture = await create(submit);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    buttons(fixture)[1].click();
    fixture.detectChanges();
    // Both buttons wait for git, so the dialog cannot vanish over a running stash.
    expect(buttons(fixture).map((button) => button.disabled)).toEqual([true, true]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).not.toHaveBeenCalled();

    finish();
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('closes without stashing on cancel', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create(submit);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    buttons(fixture)[0].click();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
});
