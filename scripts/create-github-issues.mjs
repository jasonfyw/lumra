#!/usr/bin/env node
/**
 * Creates one GitHub issue per epic and per task in docs/PLAN.md, linking tasks as sub-issues.
 * docs/PLAN.md stays the source of truth; re-running skips issues whose title already exists.
 *
 * Usage: node scripts/create-github-issues.mjs [--repo owner/name] [--dry-run]
 * Requires an authenticated GitHub CLI (`gh auth login`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const repoFlag = args.indexOf('--repo');
const repo = repoFlag >= 0 ? args[repoFlag + 1] : 'jasonfyw/lumra';

const plan = readFileSync(new URL('../docs/PLAN.md', import.meta.url), 'utf8');
const section = plan.split('## 3. Epics & tasks')[1].split('## 4.')[0];

/** @type {{ key: string, title: string, intro: string, tasks: { id: string, title: string, body: string }[] }[]} */
const epics = [];
for (const block of section.split(/^### /m).slice(1)) {
  const [heading, ...rest] = block.split('\n');
  const key = heading.split(' ')[0];
  const epic = { key, title: heading.trim(), intro: '', tasks: [] };
  const text = rest.join('\n');
  const taskRe = /^\*\*(T\d{2}) ([^*]+)\*\*([\s\S]*?)(?=^\*\*T\d{2} |(?![\s\S]))/gm;
  let match;
  while ((match = taskRe.exec(text))) {
    epic.tasks.push({ id: match[1], title: match[2].trim(), body: match[3].trim() });
  }
  if (epic.tasks.length === 0) epic.intro = text.trim();
  epics.push(epic);
}

function gh(...ghArgs) {
  return execFileSync('gh', ghArgs, { encoding: 'utf8' }).trim();
}

const footer = '\n\n---\nSource: `docs/PLAN.md` · Spec: `docs/PRD.md`';
const existing = dryRun
  ? new Map()
  : new Map(
      JSON.parse(
        gh(
          'issue',
          'list',
          '--repo',
          repo,
          '--state',
          'all',
          '--limit',
          '500',
          '--json',
          'number,title',
        ),
      ).map((i) => [i.title, i.number]),
    );

function ensureLabel(name, color) {
  if (dryRun) return;
  try {
    gh('label', 'create', name, '--repo', repo, '--color', color, '--force');
  } catch {
    /* label exists or no permission; issue creation will surface real errors */
  }
}

function createIssue(title, body, labels) {
  if (existing.has(title)) {
    console.info(`skip  #${existing.get(title)} ${title}`);
    return existing.get(title);
  }
  if (dryRun) {
    console.info(`would create [${labels.join(', ')}] ${title}`);
    return 0;
  }
  const url = gh(
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    title,
    '--body',
    body + footer,
    ...labels.flatMap((l) => ['--label', l]),
  );
  const number = Number(url.split('/').pop());
  console.info(`created #${number} ${title}`);
  return number;
}

function linkSubIssue(parent, child) {
  if (dryRun || !parent || !child) return;
  const childId = gh('api', `repos/${repo}/issues/${child}`, '--jq', '.id');
  try {
    gh(
      'api',
      '-X',
      'POST',
      `repos/${repo}/issues/${parent}/sub_issues`,
      '-F',
      `sub_issue_id=${childId}`,
    );
  } catch {
    /* already linked */
  }
}

ensureLabel('epic', '5319e7');
ensureLabel('task', '0e8a16');
for (const epic of epics) {
  const phaseLabel = `phase:${epic.key}`;
  ensureLabel(phaseLabel, 'c5def5');
  const epicBody =
    epic.intro ||
    `Tasks:\n${epic.tasks.map((t) => `- ${t.id} ${t.title}`).join('\n')}\n\nSee \`docs/PLAN.md\` §3 for scope and acceptance criteria.`;
  const epicNumber = createIssue(
    `[Epic ${epic.key}] ${epic.title.replace(/^\S+ — /, '')}`,
    epicBody,
    ['epic', phaseLabel],
  );
  for (const task of epic.tasks) {
    // Task text starts with "· Deps: X" then either a new line or " — description" (P6 one-liners).
    const [firstLine, ...moreLines] = task.body.split('\n');
    const [deps, inline] = firstLine.replace(/^·\s*Deps:\s*/, '').split(' — ');
    const description = [inline, ...moreLines].filter(Boolean).join('\n').trim();
    const body = `**Depends on:** ${deps.trim()}\n\n${description}`;
    const number = createIssue(`${task.id} ${task.title}`, body, ['task', phaseLabel]);
    linkSubIssue(epicNumber, number);
  }
}
