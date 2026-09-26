import { Pipe, PipeTransform } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { describe, expect, it, vi } from 'vitest';
import { GitNameDialog } from './git-name-dialog';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

async function create(inputs: Record<string, unknown>): Promise<ComponentFixture<GitNameDialog>> {
  TestBed.overrideComponent(GitNameDialog, {
    remove: { imports: [TranslocoPipe] },
    add: { imports: [StubTranslocoPipe] },
  });
  const fixture = TestBed.createComponent(GitNameDialog);
  fixture.componentRef.setInput('titleKey', 'git.createBranch');
  fixture.componentRef.setInput('labelKey', 'git.branchName');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function field(fixture: ComponentFixture<GitNameDialog>): HTMLInputElement {
  return fixture.nativeElement.querySelector('#git-name-dialog-input');
}

function confirmButton(fixture: ComponentFixture<GitNameDialog>): HTMLButtonElement {
  return fixture.nativeElement.querySelectorAll('footer button')[1];
}

function type(fixture: ComponentFixture<GitNameDialog>, value: string): void {
  const input = field(fixture);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('GitNameDialog', () => {
  it('submits the trimmed name and closes', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create({ submit, checkoutLabelKey: 'git.checkoutAfterCreate' });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    type(fixture, '  feature/x  ');
    confirmButton(fixture).click();
    await fixture.whenStable();

    expect(submit).toHaveBeenCalledWith({ name: 'feature/x', message: '', checkout: true });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('stays open and shows the error when the action fails', async () => {
    const submit = vi.fn().mockRejectedValue("fatal: 'a..b' is not a valid branch name");
    const fixture = await create({ submit });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    type(fixture, 'a..b');
    confirmButton(fixture).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(closed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('is not a valid branch name');
    expect(confirmButton(fixture).disabled).toBe(false);
  });

  it('starts from the initial value and only confirms a non-empty name', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create({ submit, initialValue: 'main' });
    expect(field(fixture).value).toBe('main');
    expect(confirmButton(fixture).disabled).toBe(false);

    type(fixture, '   ');
    expect(confirmButton(fixture).disabled).toBe(true);
    confirmButton(fixture).click();
    await fixture.whenStable();
    expect(submit).not.toHaveBeenCalled();
  });

  it('reports no checkout when the dialog has no checkout option', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const fixture = await create({ submit, messageLabelKey: 'git.menu.tagMessage' });

    type(fixture, 'v1.0.0');
    const message: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
    message.value = ' release ';
    message.dispatchEvent(new Event('input'));
    confirmButton(fixture).click();
    await fixture.whenStable();

    expect(submit).toHaveBeenCalledWith({ name: 'v1.0.0', message: 'release', checkout: false });
  });
});
