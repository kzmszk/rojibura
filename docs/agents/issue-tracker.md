# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues:
https://github.com/kzmszk/rojibura/issues

Use the `gh` CLI. Run commands from this repository and explicitly target
`kzmszk/rojibura` with `--repo` where supported.

## Repository selection

Before the first issue creation in a session, verify the target with:
`gh repo view kzmszk/rojibura --json nameWithOwner`.

Create issues only in `kzmszk/rojibura`. Do not use the upstream skills
repository as the destination.

## Issue operations

- Create: `gh issue create --repo kzmszk/rojibura --title "..." --body-file <file>`.
- Read: `gh issue view <number> --repo kzmszk/rojibura --json number,title,body,labels,comments`.
- List: `gh issue list --repo kzmszk/rojibura --state open --json number,title,body,labels`.
  Add label filters when relevant; paginate API requests when exhaustive coverage is required.
- Comment: `gh issue comment <number> --repo kzmszk/rojibura --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --repo kzmszk/rojibura --add-label "..."` or `--remove-label "..."`.
- Close: post the explanation as a comment first, then run
  `gh issue close <number> --repo kzmszk/rojibura`.

Write multiline bodies to a temporary file and pass `--body-file`.
Do not rely on `gh issue close --comment` to add a comment to an already-closed issue.

## Parent issues and dependencies

Prefer native GitHub sub-issues and issue dependencies.

- Add a child:
  `gh api --method POST repos/kzmszk/rojibura/issues/<parent>/sub_issues -F sub_issue_id=<child-database-id>`.
- Add a blocker:
  `gh api --method POST repos/kzmszk/rojibura/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`.
- Look up a database ID:
  `gh api repos/kzmszk/rojibura/issues/<number> --jq .id`.
  Use the numeric database ID, not the issue number or node ID.
- Count open blockers:
  `gh api repos/kzmszk/rojibura/issues/<number> --jq .issue_dependencies_summary.blocked_by`.

If native sub-issues are unavailable, put `Part of #<parent>` at the top
of the child body and add the child to a task list in the parent.
If native dependencies are unavailable, put `Blocked by: #<number>, ...`
at the top of the child body.
An issue is unblocked when every blocker is closed.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill terminology

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the corresponding GitHub issue.

## Wayfinding operations

The `/wayfinder` map is one issue labelled `wayfinder:map`, containing
Notes, Decisions-so-far, and Fog.

- Link child tickets as sub-issues, using the fallback above if necessary.
- Label children `wayfinder:<type>`, where type is
  `research`, `prototype`, `grilling`, or `task`.
- To select work, examine open children in map order and choose the first
  issue with no open blockers and no assignee.
- Claim it with `gh issue edit <number> --repo kzmszk/rojibura --add-assignee @me`.
- To resolve it, comment with the result, close the child, and add a brief
  result and link to the map's Decisions-so-far.
