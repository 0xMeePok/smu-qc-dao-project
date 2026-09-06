# Contributing

## 1. Introduction

This document gives the rules for commit messages and pull requests.
Follow these rules for each contribution to this project.

The rules have three purposes:

- They make the project history easy to read.
- They let the tools make the release notes automatically.
- They make each review more quick.

## 2. Before you start

1. Decide on which user story to work on from Jira.
2. Make a new branch from `main`.
3. Do the work in that branch.
4. Make a pull request when the work is complete.

Do not commit directly to `main`.

## 3. Branch names

Use this format for the name of a branch:

```
qcdao-<user-story-number>-<user-story-description>
```

- `<user-story-number>` is the number of the related user story from jira.
- `<user-story-description>` is the name of the related user story from jira, each word separated using dash.

Examples:

```
qcdao-40-onboarding-a-new-account
qcdao-53-search-and-filter-opportunities
qcdao-74-design-and-deploy-audit-registry-smart-contract
```

Delete the branch after the merge.

## 4. Commit messages

This project uses the Conventional Commits standard.

### 4.1 Structure

```
<subject>

<body>

<footer>
```

The subject are mandatory.
The body and the footer are optional.
Put one empty line between each part.

### 4.2 Subject rules

1. Use the imperative form of the verb. Write `add`, not `added` or `adds`.
2. Start the subject with a lowercase letter.
3. Do not put a period at the end.
4. Use a maximum of 50 characters.
5. Write what the commit does. Do not write how it does it.

### 4.3 Body rules

1. Write a body when the change is not obvious.
2. Tell why you made the change.
3. Tell which behavior is different than before.
4. Break each line at 72 characters.
5. Use a maximum of 25 words in a sentence.

### 4.4 Footer rules

1. Refer to the related issue. Use `Closes #142` or `Refs #142`.
2. For a change that breaks compatibility, start a footer line with `BREAKING CHANGE:`. Then give a description.
3. As an alternative, put a `!` after the type or the scope.

## 5. Pull requests

### 5.1 Rules

1. Make one pull request upon completion of the feature.
2. Make sure that all the tests pass before you ask for a review.
3. Make sure **Semgrep** (rule-based SAST on the PR) and **Gitleaks** (secret scan on each push) have passed. Maintainers should mark both as required status checks on `main`.

### 5.2 Review

- You must get at least one approval before a merge.
- Do not merge your own pull request without an approval.
- Make a new commit for each correction. Do not change the history during a review.

### 5.3 Merge

- Use `Squash and merge`.
- Delete the branch after the merge.