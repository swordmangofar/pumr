import type { Page } from '@playwright/test';
import type { FakeSeed } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

/** What is committed, and the project folder with local work on top of it. */
const COMMITTED = {
  'README.md': '# demo\n',
  'notes.txt': 'alpha\nbravo\n',
  'old.txt': 'old\n',
  'shared.txt': 'ours\n',
};
const WORK_TREE = {
  'README.md': '# demo\nmore\n',
  'notes.txt': 'alpha\nbravo\ncharlie\n',
  'new.txt': 'new\n',
  'shared.txt': 'ours\n',
};
/** The files with local changes in `WORK_TREE`. */
const CHANGED = ['README.md', 'new.txt', 'notes.txt', 'old.txt'];
const HASH = (letter: string) => letter.repeat(40);

const branch = (name: string, current = false) => ({
  name,
  current,
  remote: false,
  upstream: null,
  remoteName: null,
  remoteBranch: null,
  hash: HASH('a'),
  subject: 'Initial commit',
  timestamp: 1_700_000_000_000,
});

const commit = (hash: string, subject: string, parents: string[] = []) => ({
  hash,
  shortHash: hash.slice(0, 7),
  author: 'e2e',
  timestamp: 1_700_000_000_000,
  subject,
  refs: [],
  parents,
});

/** Opens the Git tab of a repository with staged nothing and four changed files. */
async function openGit(page: Page, app: PumrApp, patch: Partial<FakeSeed> = {}): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(
    seed({
      projects: [project()],
      sessions: [session()],
      files: WORK_TREE,
      repo: true,
      ...patch,
      git: { committed: COMMITTED, ...patch.git },
    }),
  );
  await page
    .locator('app-sidebar')
    .getByRole('button', { name: 'Git', exact: true })
    .first()
    .click();
}

const view = (page: Page) => page.locator('app-git-view');
const sidebar = (page: Page) => page.locator('app-git-sidebar');
/** The row of a changed file in the unstaged or the staged list. */
const row = (page: Page, path: string, staged = false) =>
  view(page).locator(`[data-git-file="${staged ? 's' : 'u'}:${path}"]`);

async function rowAction(page: Page, path: string, name: string, staged = false): Promise<void> {
  await row(page, path, staged).hover();
  await row(page, path, staged).getByRole('button', { name, exact: true }).click();
}

/** The questions the app asked in native confirm dialogs, in order. */
async function questions(app: PumrApp): Promise<string[]> {
  return (await app.backend.calls('plugin:dialog|message')).map((call) =>
    String(call.args['message']),
  );
}

const argsOf = async (app: PumrApp, cmd: string) =>
  (await app.backend.calls(cmd)).map((call) => call.args);

test.describe('the changes of a repository', () => {
  test('are staged and unstaged one by one or all at once', async ({ app, page }) => {
    await openGit(page, app);
    for (const path of ['README.md', 'new.txt', 'notes.txt', 'old.txt']) {
      await expect(row(page, path)).toBeVisible();
    }
    await expect(view(page)).toContainText('No staged changes.');

    await rowAction(page, 'notes.txt', 'Stage');
    await expect(row(page, 'notes.txt', true)).toBeVisible();
    await expect(row(page, 'notes.txt')).toHaveCount(0);
    await expect(row(page, 'README.md')).toBeVisible();
    expect(await argsOf(app, 'git_stage')).toEqual([{ projectId: 'project-1', path: 'notes.txt' }]);

    await view(page).getByRole('button', { name: 'Stage all', exact: true }).click();
    await expect(view(page)).toContainText('No local changes.');
    await expect(row(page, 'old.txt', true)).toBeVisible();
    expect((await app.backend.lastCall('git_stage'))?.args).toEqual({
      projectId: 'project-1',
      path: null,
    });

    await rowAction(page, 'README.md', 'Unstage', true);
    await expect(row(page, 'README.md')).toBeVisible();
    await expect(row(page, 'new.txt', true)).toBeVisible();
    expect(await argsOf(app, 'git_unstage')).toEqual([
      { projectId: 'project-1', path: 'README.md' },
    ]);

    await view(page).getByRole('button', { name: 'Unstage all', exact: true }).click();
    await expect(view(page)).toContainText('No staged changes.');
    await expect(row(page, 'new.txt')).toBeVisible();
    // Staging never reaches for the files themselves.
    expect(await argsOf(app, 'git_discard_paths')).toEqual([]);
  });

  test('are only discarded after a question, and not when it is declined', async ({
    app,
    page,
  }) => {
    await openGit(page, app, { confirm: false });

    await rowAction(page, 'notes.txt', 'Discard');

    await expect
      .poll(() => questions(app))
      .toEqual(['Discard changes to "notes.txt"? This cannot be undone.']);
    await expect(row(page, 'notes.txt')).toBeVisible();
    expect(await argsOf(app, 'git_discard_paths')).toEqual([]);
  });

  test('are discarded for the one file that was picked', async ({ app, page }) => {
    await openGit(page, app);

    await rowAction(page, 'notes.txt', 'Discard');

    await expect(row(page, 'notes.txt')).toHaveCount(0);
    expect(await argsOf(app, 'git_discard_paths')).toEqual([
      { projectId: 'project-1', paths: ['notes.txt'] },
    ]);
    for (const path of ['README.md', 'new.txt', 'old.txt']) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('are discarded as a selection with one question, leaving staged files alone', async ({
    app,
    page,
  }) => {
    await openGit(page, app);
    await rowAction(page, 'README.md', 'Stage');
    await expect(row(page, 'README.md', true)).toBeVisible();

    await row(page, 'notes.txt').getByText('notes.txt').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');

    await expect
      .poll(() => questions(app))
      .toEqual(['Discard changes to 3 files? This cannot be undone.']);
    await expect(view(page)).toContainText('No local changes.');
    expect(await argsOf(app, 'git_discard_paths')).toEqual([
      { projectId: 'project-1', paths: ['new.txt', 'notes.txt', 'old.txt'] },
    ]);
    await expect(row(page, 'README.md', true)).toBeVisible();
  });

  test('stay listed with the reason when git refuses to discard them', async ({ app, page }) => {
    const refusal = 'vendor/lib/ is a git repository and was not deleted';
    await openGit(page, app, { failures: { git_discard_paths: refusal } });

    await rowAction(page, 'notes.txt', 'Discard');

    await expect(view(page)).toContainText(refusal);
    await expect(row(page, 'notes.txt')).toBeVisible();
  });
});

test.describe('a commit', () => {
  const commitButton = (page: Page) =>
    view(page).getByRole('button', { name: 'Commit', exact: true });
  const subject = (page: Page) => view(page).getByPlaceholder('Commit subject');

  test('needs a subject and staged changes, and takes only what is staged', async ({
    app,
    page,
  }) => {
    await openGit(page, app);
    await expect(commitButton(page)).toBeDisabled();
    await subject(page).fill('Update the notes');
    // A subject alone is not enough: nothing is staged yet.
    await expect(commitButton(page)).toBeDisabled();
    await rowAction(page, 'notes.txt', 'Stage');
    await view(page).getByPlaceholder('Description').fill('Adds charlie.');

    await commitButton(page).click();

    await expect(row(page, 'notes.txt', true)).toHaveCount(0);
    expect(await argsOf(app, 'git_commit')).toEqual([
      { projectId: 'project-1', message: 'Update the notes\n\nAdds charlie.', amend: false },
    ]);
    await expect(subject(page)).toHaveValue('');
    // What was not staged is still local work.
    for (const path of ['README.md', 'new.txt', 'old.txt']) {
      await expect(row(page, path)).toBeVisible();
    }
    expect(await argsOf(app, 'git_push')).toEqual([]);
  });

  test('keeps the message and the staged files when it fails', async ({ app, page }) => {
    await openGit(page, app, { failures: { git_commit: 'the pre-commit hook failed' } });
    await rowAction(page, 'notes.txt', 'Stage');
    await subject(page).fill('Update the notes');

    await commitButton(page).click();

    await expect(view(page)).toContainText('the pre-commit hook failed');
    await expect(subject(page)).toHaveValue('Update the notes');
    await expect(row(page, 'notes.txt', true)).toBeVisible();
  });

  test('is amended with the previous message filled in', async ({ app, page }) => {
    await openGit(page, app, {
      git: { commits: [commit(HASH('a'), 'Previous subject')] },
    });

    await view(page).getByLabel('Amend').check();

    await expect(subject(page)).toHaveValue('Previous subject');
    await commitButton(page).click();
    await app.backend.waitForCall('git_commit');
    expect(await argsOf(app, 'git_commit')).toEqual([
      { projectId: 'project-1', message: 'Previous subject', amend: true },
    ]);
  });
});

test.describe('single lines of a change', () => {
  const diff = (page: Page) => view(page).locator('app-hunk-diff-view');

  test('are only discarded after a question', async ({ app, page }) => {
    await openGit(page, app, { confirm: false });
    await row(page, 'notes.txt').getByText('notes.txt').click();
    await expect(diff(page)).toContainText('charlie');

    await diff(page).getByRole('button', { name: 'Discard hunk…' }).click();

    await expect
      .poll(() => questions(app))
      .toEqual(['Discard 1 changed lines? This cannot be undone.']);
    expect(await argsOf(app, 'git_apply_lines')).toEqual([]);

    await app.backend.setConfirm(true);
    await diff(page).getByRole('button', { name: 'Discard hunk…' }).click();

    await expect(row(page, 'notes.txt')).toHaveCount(0);
    const [applied] = await argsOf(app, 'git_apply_lines');
    expect(applied).toMatchObject({
      projectId: 'project-1',
      path: 'notes.txt',
      staged: false,
      action: 'discard',
      lines: [2],
    });
  });

  test('are staged without a question and move the file over', async ({ app, page }) => {
    await openGit(page, app);
    await row(page, 'notes.txt').getByText('notes.txt').click();
    await expect(diff(page)).toContainText('charlie');

    await diff(page).getByRole('button', { name: 'Stage hunk' }).click();

    await expect(row(page, 'notes.txt', true)).toBeVisible();
    await expect(row(page, 'notes.txt')).toHaveCount(0);
    expect(await questions(app)).toEqual([]);
    expect(await argsOf(app, 'git_apply_lines')).toMatchObject([
      { path: 'notes.txt', staged: false, action: 'stage', lines: [2] },
    ]);
  });
});

test.describe('a project that is not a repository', () => {
  test('offers to create one and cannot fetch, pull or push', async ({ app, page }) => {
    await openGit(page, app, { repo: false });
    await expect(view(page)).toContainText('This project is not a Git repository.');
    // Without a repository there is no HEAD that could be detached.
    await expect(view(page)).not.toContainText('Detached HEAD');
    for (const name of ['Fetch', 'Pull', 'Push']) {
      await expect(view(page).getByRole('button', { name, exact: true })).toBeDisabled();
    }

    await view(page).getByRole('button', { name: 'Initialize repository' }).click();

    await expect(row(page, 'notes.txt')).toBeVisible();
    await expect(view(page).getByRole('button', { name: 'Fetch', exact: true })).toBeEnabled();
    expect(await argsOf(app, 'git_init')).toEqual([{ projectId: 'project-1' }]);
    for (const cmd of ['git_fetch', 'git_pull', 'git_push']) {
      expect(await argsOf(app, cmd)).toEqual([]);
    }
  });
});

test.describe('stashes, tags and branches', () => {
  const refs = {
    branches: [branch('main', true), branch('wip')],
    tags: [{ name: 'v1', hash: HASH('a') }],
    stashes: [{ name: 'stash@{0}', hash: HASH('f'), message: 'On main: half done' }],
  };

  test('are only dropped or deleted after a question', async ({ app, page }) => {
    await openGit(page, app, { confirm: false, git: { refs } });
    await sidebar(page)
      .getByRole('button', { name: /^\s*Stashes/ })
      .click();
    const stash = sidebar(page).getByTitle('stash@{0}');
    await expect(stash).toContainText('half done');
    await sidebar(page)
      .getByRole('button', { name: /^\s*Tags/ })
      .click();
    const tag = sidebar(page)
      .locator('li, div')
      .filter({ hasText: /^\s*v1/ })
      .last();

    await stash.hover();
    await stash.getByRole('button', { name: 'Delete…' }).click();
    await tag.hover();
    await tag.getByRole('button', { name: 'Delete…' }).click();

    await expect
      .poll(() => questions(app))
      .toEqual(['Drop stash@{0}: On main: half done?', 'Delete tag v1?']);
    expect(await argsOf(app, 'git_stash_drop')).toEqual([]);
    expect(await argsOf(app, 'git_tag_delete')).toEqual([]);

    await app.backend.setConfirm(true);
    await stash.hover();
    await stash.getByRole('button', { name: 'Delete…' }).click();
    await expect(sidebar(page).getByTitle('stash@{0}')).toHaveCount(0);
    expect(await argsOf(app, 'git_stash_drop')).toEqual([
      { projectId: 'project-1', stash: 'stash@{0}', hash: HASH('f') },
    ]);
    await tag.hover();
    await tag.getByRole('button', { name: 'Delete…' }).click();
    await app.backend.waitForCall('git_tag_delete');
    expect(await argsOf(app, 'git_tag_delete')).toEqual([{ projectId: 'project-1', name: 'v1' }]);
  });

  test('ask again before an unmerged branch is deleted by force', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, unmerged: ['wip'] } });

    await branchRow(page, 'wip').click({ button: 'right' });
    await page.getByRole('button', { name: 'Delete…' }).click();

    await expect(branchRow(page, 'wip')).toHaveCount(0);
    await expect(branchRow(page, 'main')).toBeVisible();
    expect(await questions(app)).toEqual([
      "Delete branch 'wip'? This cannot be undone.",
      "Branch 'wip' is not fully merged. Delete it anyway? Its unmerged commits will be lost.",
    ]);
    expect(await argsOf(app, 'git_branch_delete')).toEqual([
      { projectId: 'project-1', branch: 'wip', remote: false, force: false },
      { projectId: 'project-1', branch: 'wip', remote: false, force: true },
    ]);
  });

  test('keep an unmerged branch when forcing is declined', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, unmerged: ['wip'] } });
    // Yes to deleting, then no to forcing it.
    await app.backend.answerNext(true, false);

    await branchRow(page, 'wip').click({ button: 'right' });
    await page.getByRole('button', { name: 'Delete…' }).click();

    await expect.poll(async () => (await questions(app)).length).toBe(2);
    await expect(branchRow(page, 'wip')).toBeVisible();
    expect(await argsOf(app, 'git_branch_delete')).toEqual([
      { projectId: 'project-1', branch: 'wip', remote: false, force: false },
    ]);
  });
});

test.describe('the history', () => {
  const commits = [
    commit(HASH('b'), 'Second commit', [HASH('a')]),
    commit(HASH('a'), 'Initial commit'),
  ];

  test('is only reset hard after a question', async ({ app, page }) => {
    await openGit(page, app, {
      confirm: false,
      git: { commits, refs: { branches: [{ ...branch('main', true), hash: HASH('b') }] } },
    });
    await sidebar(page).getByRole('button', { name: 'All Commits' }).click();
    const older = view(page).getByText('Initial commit').first();
    await expect(older).toBeVisible();

    await older.click({ button: 'right' });
    await page.getByRole('button', { name: 'Reset main to here' }).click();
    await page.getByRole('button', { name: /Hard/ }).click();

    await expect.poll(async () => (await questions(app)).length).toBe(1);
    expect((await questions(app))[0]).toContain('discard all uncommitted changes');
    expect(await argsOf(app, 'git_reset')).toEqual([]);

    await app.backend.setConfirm(true);
    await older.click({ button: 'right' });
    await page.getByRole('button', { name: 'Reset main to here' }).click();
    await page.getByRole('button', { name: /Hard/ }).click();

    await app.backend.waitForCall('git_reset');
    expect(await argsOf(app, 'git_reset')).toEqual([
      { projectId: 'project-1', hash: HASH('a'), mode: 'hard' },
    ]);
  });
});

/** A button of the bar above the changes, where fetch, pull and push are. */
const toolbar = (page: Page, name: string) => view(page).getByRole('button', { name, exact: true });
/** The branch a context menu is opened on, in the sidebar. */
const branchRow = (page: Page, name: string | RegExp) =>
  sidebar(page).getByRole('button', { name, exact: true });

async function branchMenu(page: Page, name: string | RegExp, item: string): Promise<void> {
  await branchRow(page, name).click({ button: 'right' });
  await page.getByRole('button', { name: item, exact: true }).click();
}

test.describe('the branch button next to fetch', () => {
  const dialog = (page: Page) => page.locator('app-git-name-dialog');
  const refs = { branches: [branch('main', true)] };

  test('creates a branch at the current one and switches to it', async ({ app, page }) => {
    await openGit(page, app, { git: { refs } });

    await toolbar(page, 'Branch').click();
    await expect(dialog(page)).toContainText('Create branch at: main');
    await dialog(page).getByLabel('Branch name').fill('feature/login');
    await dialog(page).getByRole('button', { name: 'Create and checkout' }).click();

    await expect(dialog(page)).toHaveCount(0);
    expect(await argsOf(app, 'git_branch_create')).toEqual([
      { projectId: 'project-1', name: 'feature/login', startPoint: null, checkout: true },
    ]);
    await expect(view(page).getByText('feature/login', { exact: true })).toBeVisible();
    await expect(branchRow(page, 'login')).toBeVisible();
    // The local changes come along to the new branch.
    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('creates a branch without leaving the current one', async ({ app, page }) => {
    await openGit(page, app, { git: { refs } });

    await toolbar(page, 'Branch').click();
    await dialog(page).getByLabel('Branch name').fill('later');
    await dialog(page).getByLabel('Check out after create').uncheck();
    await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();

    await expect(branchRow(page, 'later')).toBeVisible();
    expect(await argsOf(app, 'git_branch_create')).toEqual([
      { projectId: 'project-1', name: 'later', startPoint: null, checkout: false },
    ]);
    await expect(view(page).getByText('main', { exact: true })).toBeVisible();
  });

  test('keeps the dialog open with the reason when git refuses the name', async ({ app, page }) => {
    await openGit(page, app, { git: { refs } });

    await toolbar(page, 'Branch').click();
    await dialog(page).getByLabel('Branch name').fill('main');
    await dialog(page).getByRole('button', { name: 'Create and checkout' }).click();

    await expect(dialog(page)).toContainText("a branch named 'main' already exists");
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(branchRow(page, 'main')).toHaveCount(1);
  });
});

test.describe('the stash button next to fetch', () => {
  const dialog = (page: Page) => page.locator('app-git-stash-dialog');
  const confirm = (page: Page) => dialog(page).getByRole('button', { name: 'Stash', exact: true });

  test('puts the local changes away under a message and they come back', async ({ app, page }) => {
    await openGit(page, app);

    await toolbar(page, 'Stash').click();
    await dialog(page).getByLabel('Message (optional)').fill('half done');
    await confirm(page).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(view(page)).toContainText('No local changes.');
    expect(await argsOf(app, 'git_stash_push')).toEqual([
      { projectId: 'project-1', message: 'half done', includeUntracked: true },
    ]);
    // With nothing left to stash, the button has nothing to do.
    await expect(toolbar(page, 'Stash')).toBeDisabled();

    await sidebar(page)
      .getByRole('button', { name: /^\s*Stashes/ })
      .click();
    const stash = sidebar(page).getByTitle('stash@{0}');
    await expect(stash).toContainText('half done');
    await stash.hover();
    await stash.getByRole('button', { name: 'Pop' }).click();

    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
    await expect(sidebar(page).getByTitle('stash@{0}')).toHaveCount(0);
  });

  test('leaves new files in the folder when untracked files are not included', async ({
    app,
    page,
  }) => {
    await openGit(page, app);

    await toolbar(page, 'Stash').click();
    await dialog(page).getByLabel('Include untracked files').uncheck();
    await confirm(page).click();

    await expect(row(page, 'notes.txt')).toHaveCount(0);
    await expect(row(page, 'new.txt')).toBeVisible();
    expect(await argsOf(app, 'git_stash_push')).toEqual([
      { projectId: 'project-1', message: null, includeUntracked: false },
    ]);
  });

  test('stashes nothing when the dialog is cancelled or git fails', async ({ app, page }) => {
    await openGit(page, app, { failures: { git_stash_push: 'error: could not write index' } });

    await toolbar(page, 'Stash').click();
    await expect(dialog(page).getByLabel('Message (optional)')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(await argsOf(app, 'git_stash_push')).toEqual([]);

    await toolbar(page, 'Stash').click();
    await confirm(page).click();
    // The failure is shown where the stash was asked for, and nothing moved.
    await expect(dialog(page)).toContainText('could not write index');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('closes the diff of a file it put away', async ({ app, page }) => {
    await openGit(page, app);
    await row(page, 'notes.txt').getByText('notes.txt').click();
    await expect(view(page).locator('app-hunk-diff-view')).toContainText('charlie');

    await toolbar(page, 'Stash').click();
    await confirm(page).click();

    await expect(view(page)).toContainText('Select a file to view its changes.');
    await expect(view(page).locator('app-hunk-diff-view')).toHaveCount(0);
  });

  test('needs local changes, and both buttons need a repository', async ({ app, page }) => {
    await openGit(page, app, { files: COMMITTED });
    await expect(view(page)).toContainText('No local changes.');
    await expect(toolbar(page, 'Stash')).toBeDisabled();
    await expect(toolbar(page, 'Branch')).toBeEnabled();
  });

  test('is not offered for a folder that is no repository', async ({ app, page }) => {
    await openGit(page, app, { repo: false });
    await expect(view(page)).toContainText('This project is not a Git repository.');
    await expect(toolbar(page, 'Stash')).toBeDisabled();
    await expect(toolbar(page, 'Branch')).toBeDisabled();
  });
});

test.describe('merging a branch', () => {
  const refs = { branches: [branch('main', true), branch('feature')] };
  const clean = { feature: { changes: { 'feature.txt': 'feature\n' } } };
  const conflicting = {
    feature: { changes: { 'feature.txt': 'feature\n' }, conflicts: { 'shared.txt': 'theirs\n' } },
  };
  const proceed = (page: Page) => toolbar(page, 'Continue');

  async function startConflict(page: Page, app: PumrApp): Promise<void> {
    await branchMenu(page, 'feature', "Merge into 'main'…");
    await expect(view(page)).toContainText('Merge in progress');
    expect(await argsOf(app, 'git_merge')).toEqual([{ projectId: 'project-1', branch: 'feature' }]);
  }

  test('asks first and does nothing when declined', async ({ app, page }) => {
    await openGit(page, app, { confirm: false, git: { refs, incoming: clean } });

    await branchMenu(page, 'feature', "Merge into 'main'…");

    await expect.poll(() => questions(app)).toEqual(["Merge 'feature' into 'main'?"]);
    expect(await argsOf(app, 'git_merge')).toEqual([]);
    await expect(view(page)).not.toContainText('in progress');
  });

  test('brings the branch in and keeps the local changes', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, incoming: clean } });

    await branchMenu(page, 'feature', "Merge into 'main'…");

    await expect(view(page)).toContainText("Merge made by the 'ort' strategy.");
    expect(await argsOf(app, 'git_merge')).toEqual([{ projectId: 'project-1', branch: 'feature' }]);
    await expect(view(page)).not.toContainText('in progress');
    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('stops at a conflict until every file is resolved, then continues', async ({
    app,
    page,
  }) => {
    await openGit(page, app, { git: { refs, incoming: conflicting } });
    await startConflict(page, app);

    await expect(view(page)).toContainText('1 conflicted files');
    await expect(view(page)).toContainText('CONFLICT (content): Merge conflict in shared.txt');
    await expect(proceed(page)).toBeDisabled();
    // Git cannot stash in the middle of a merge.
    await expect(toolbar(page, 'Stash')).toBeDisabled();

    await row(page, 'shared.txt').getByText('shared.txt').click();
    await expect(view(page)).toContainText('This file has conflicts.');
    // The file is shown whole, with both sides between git's markers.
    const conflict = view(page).locator('app-diff-view');
    await expect(conflict).toContainText('<<<<<<< HEAD');
    await expect(conflict).toContainText('theirs');
    await toolbar(page, 'Use incoming (theirs)').click();

    await expect(proceed(page)).toBeEnabled();
    expect(await argsOf(app, 'git_resolve_conflict')).toEqual([
      { projectId: 'project-1', path: 'shared.txt', side: 'theirs' },
    ]);
    await proceed(page).click();

    await expect(view(page)).not.toContainText('Merge in progress');
    expect(await argsOf(app, 'git_operation_continue')).toEqual([
      { projectId: 'project-1', operation: 'merge' },
    ]);
    expect(await argsOf(app, 'git_operation_abort')).toEqual([]);
  });

  test('is undone by abort, back to the local changes as they were', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, incoming: conflicting } });
    await startConflict(page, app);
    await expect(row(page, 'shared.txt')).toBeVisible();

    await toolbar(page, 'Abort').click();

    await expect(view(page)).not.toContainText('Merge in progress');
    expect(await argsOf(app, 'git_operation_abort')).toEqual([
      { projectId: 'project-1', operation: 'merge' },
    ]);
    await expect(row(page, 'shared.txt')).toHaveCount(0);
    await expect(row(page, 'feature.txt', true)).toHaveCount(0);
    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('asks before a file that still has conflict markers counts as resolved', async ({
    app,
    page,
  }) => {
    await openGit(page, app, { confirm: false, git: { refs, incoming: conflicting } });
    // Yes to the merge, no to the markers.
    await app.backend.answerNext(true, false);
    await startConflict(page, app);
    await row(page, 'shared.txt').getByText('shared.txt').click();

    await toolbar(page, 'Mark as resolved').click();

    await expect.poll(async () => (await questions(app)).length).toBe(2);
    expect((await questions(app))[1]).toContain('still contains conflict markers');
    expect(await argsOf(app, 'git_stage')).toEqual([]);
    await expect(proceed(page)).toBeDisabled();

    await app.backend.setConfirm(true);
    await toolbar(page, 'Mark as resolved').click();

    await expect(proceed(page)).toBeEnabled();
    expect(await argsOf(app, 'git_stage')).toEqual([
      { projectId: 'project-1', path: 'shared.txt' },
    ]);
  });

  test('keeps the side that is already there when "ours" is chosen', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, incoming: conflicting } });
    await startConflict(page, app);
    await row(page, 'shared.txt').getByText('shared.txt').click();

    await toolbar(page, 'Use current (ours)').click();

    await expect(proceed(page)).toBeEnabled();
    expect(await argsOf(app, 'git_resolve_conflict')).toEqual([
      { projectId: 'project-1', path: 'shared.txt', side: 'ours' },
    ]);
    // What merged cleanly is staged for the merge commit; the conflict is gone.
    await expect(row(page, 'feature.txt', true)).toBeVisible();
    await expect(row(page, 'shared.txt')).toHaveCount(0);
  });

  test('unstages what merged cleanly and leaves the conflicted file as it is', async ({
    app,
    page,
  }) => {
    await openGit(page, app, { git: { refs, incoming: conflicting } });
    await startConflict(page, app);
    const unstageAll = view(page).getByRole('button', { name: 'Unstage all', exact: true });

    // A conflict is resolved, not unstaged: its row has no such button.
    await row(page, 'shared.txt', true).hover();
    await expect(
      row(page, 'shared.txt', true).getByRole('button', { name: 'Unstage', exact: true }),
    ).toHaveCount(0);
    await unstageAll.click();

    await expect(row(page, 'feature.txt', true)).toHaveCount(0);
    await expect(row(page, 'shared.txt', true)).toBeVisible();
    await expect(view(page)).toContainText('1 conflicted files');
    expect(await argsOf(app, 'git_unstage')).toEqual([]);
    expect(await argsOf(app, 'git_unstage_paths')).toEqual([
      { projectId: 'project-1', paths: ['feature.txt'] },
    ]);
    // Nothing is left that could be unstaged.
    await expect(unstageAll).toHaveCount(0);
  });
});

test.describe('rebasing', () => {
  const history = [
    commit(HASH('d'), 'Third', [HASH('c')]),
    commit(HASH('c'), 'Second', [HASH('b')]),
    commit(HASH('b'), 'First', [HASH('a')]),
    commit(HASH('a'), 'Base'),
  ];
  const refs = {
    branches: [
      { ...branch('main', true), hash: HASH('d') },
      { ...branch('feature'), hash: HASH('a') },
    ],
  };
  const rebase = (page: Page) => page.locator('app-git-branch-menu');

  test('asks first, as it rewrites the commits of the branch', async ({ app, page }) => {
    await openGit(page, app, { confirm: false, git: { refs } });

    await branchMenu(page, 'feature', "Rebase on 'feature'…");

    await expect
      .poll(() => questions(app))
      .toEqual(["Rebase 'main' onto 'feature'? This rewrites the commits of 'main'."]);
    expect(await argsOf(app, 'git_rebase')).toEqual([]);

    await app.backend.setConfirm(true);
    await branchMenu(page, 'feature', "Rebase on 'feature'…");

    await app.backend.waitForCall('git_rebase');
    expect(await argsOf(app, 'git_rebase')).toEqual([{ projectId: 'project-1', onto: 'feature' }]);
  });

  test('stops at a conflict and can be aborted', async ({ app, page }) => {
    await openGit(page, app, {
      git: { refs, incoming: { feature: { conflicts: { 'shared.txt': 'theirs\n' } } } },
    });

    await branchMenu(page, 'feature', "Rebase on 'feature'…");

    await expect(view(page)).toContainText('Rebase in progress');
    await expect(toolbar(page, 'Continue')).toBeDisabled();
    await toolbar(page, 'Abort').click();
    await expect(view(page)).not.toContainText('Rebase in progress');
    expect(await argsOf(app, 'git_operation_abort')).toEqual([
      { projectId: 'project-1', operation: 'rebase' },
    ]);
    for (const path of CHANGED) {
      await expect(row(page, path)).toBeVisible();
    }
  });

  test('sends the commits in the order and with the actions that were chosen', async ({
    app,
    page,
  }) => {
    await openGit(page, app, { git: { refs, commits: history } });

    await branchMenu(page, 'feature', "Interactively Rebase on 'feature'…");
    // Oldest first, without the commit the other branch is at.
    await expect(rebase(page).locator('select')).toHaveCount(3);
    await expect(rebase(page)).toContainText('First');
    await expect(rebase(page)).not.toContainText('Base');

    await rebase(page).getByRole('button', { name: 'Move down' }).first().click();
    await rebase(page).locator('select').nth(2).selectOption('squash');
    await rebase(page).getByRole('button', { name: 'Confirm', exact: true }).click();

    await app.backend.waitForCall('git_rebase_interactive');
    expect(await argsOf(app, 'git_rebase_interactive')).toEqual([
      {
        projectId: 'project-1',
        onto: 'feature',
        todo: [
          { action: 'pick', hash: HASH('c') },
          { action: 'pick', hash: HASH('b') },
          { action: 'squash', hash: HASH('d') },
        ],
      },
    ]);
  });

  test('does not offer to squash the first commit into nothing', async ({ app, page }) => {
    await openGit(page, app, { git: { refs, commits: history } });

    await branchMenu(page, 'feature', "Interactively Rebase on 'feature'…");
    await rebase(page).locator('select').first().selectOption('squash');

    await expect(rebase(page)).toContainText('The first commit cannot be squashed or fixed up');
    await expect(rebase(page).getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
    await rebase(page).getByRole('button', { name: 'Cancel' }).click();
    expect(await argsOf(app, 'git_rebase_interactive')).toEqual([]);
  });
});

test.describe('pushing', () => {
  const subject = (page: Page) => view(page).getByPlaceholder('Commit subject');
  const sent = async (app: PumrApp) =>
    (await app.backend.calls())
      .map((call) => call.cmd)
      .filter((cmd) => cmd === 'git_commit' || cmd === 'git_push');

  test('sends the current branch from the toolbar', async ({ app, page }) => {
    await openGit(page, app);

    await toolbar(page, 'Push').click();

    await expect(view(page)).toContainText('Everything up-to-date');
    expect(await argsOf(app, 'git_push')).toEqual([{ projectId: 'project-1' }]);
  });

  test('follows a commit when asked for both, in that order', async ({ app, page }) => {
    await openGit(page, app);
    await rowAction(page, 'notes.txt', 'Stage');
    await subject(page).fill('Update the notes');

    await toolbar(page, 'Commit & Push').click();

    await app.backend.waitForCall('git_push');
    expect(await sent(app)).toEqual(['git_commit', 'git_push']);
    await expect(row(page, 'notes.txt', true)).toHaveCount(0);
  });

  test('does not happen when the commit before it fails', async ({ app, page }) => {
    await openGit(page, app, { failures: { git_commit: 'the pre-commit hook failed' } });
    await rowAction(page, 'notes.txt', 'Stage');
    await subject(page).fill('Update the notes');

    await toolbar(page, 'Commit & Push').click();

    await expect(view(page)).toContainText('the pre-commit hook failed');
    expect(await sent(app)).toEqual(['git_commit']);
  });

  test('shows why the remote rejected it, with the commit already made', async ({ app, page }) => {
    const rejected = '! [rejected] main -> main (fetch first)';
    await openGit(page, app, { failures: { git_push: rejected } });
    await rowAction(page, 'notes.txt', 'Stage');
    await subject(page).fill('Update the notes');

    await toolbar(page, 'Commit & Push').click();

    await expect(view(page)).toContainText(rejected);
    expect(await sent(app)).toEqual(['git_commit', 'git_push']);
    await expect(row(page, 'notes.txt', true)).toHaveCount(0);
    await expect(subject(page)).toHaveValue('');
  });

  test('explains a failed login instead of quoting git', async ({ app, page }) => {
    await openGit(page, app, {
      failures: { git_push: "fatal: Authentication failed for 'https://example.com/demo.git/'" },
    });

    await toolbar(page, 'Push').click();

    await expect(view(page)).toContainText('Authentication failed. Check your Git credentials.');
    await expect(view(page)).not.toContainText('example.com');
  });

  test('publishes a branch without an upstream and sets one', async ({ app, page }) => {
    const tracked = { ...branch('tracked'), upstream: 'origin/tracked', remoteName: 'origin' };
    await openGit(page, app, {
      git: { refs: { branches: [branch('main', true), tracked], remotes: ['origin'] } },
    });

    await branchMenu(page, 'main', "Push to 'origin'…");
    await app.backend.waitForCall('git_push_branch');
    // A branch with an upstream is listed with it next to its name.
    await branchMenu(page, /^tracked/, "Push to 'origin'…");
    await app.backend.waitForCall('git_push_branch', 2);

    expect(await argsOf(app, 'git_push_branch')).toEqual([
      { projectId: 'project-1', branch: 'main', remote: 'origin', setUpstream: true },
      { projectId: 'project-1', branch: 'tracked', remote: 'origin', setUpstream: false },
    ]);
  });
});
