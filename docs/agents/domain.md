# Domain docs

This repository uses one shared domain context across `apps/`,
`packages/`, and `tools/`.

## Before exploring

- Read `GLOSSARY.md` at the repository root.
- Read relevant architecture decision records in `docs/adr/`.

If these files or directories do not exist, proceed silently.
Do not flag their absence or suggest creating them upfront.
The `/domain-modeling` skill creates them when terms or decisions
actually get resolved.

## Layout

- `GLOSSARY.md`: shared domain terms and definitions.
- `docs/adr/`: architecture decisions, using numbered Markdown files.

Do not split documentation by package unless the repository explicitly
adopts multiple domain contexts later.

## Use the glossary's vocabulary

Use established terms in issue titles, proposals, explanations, and tests.
Avoid synonyms that the glossary explicitly discourages.

When a needed concept is missing, reconsider whether the term belongs
to the domain. If it does, note the gap for `/domain-modeling`.

## Surface conflicts with decisions

If a proposal contradicts an existing ADR, identify that ADR and explain
why the decision should be reconsidered. Do not silently override it.
