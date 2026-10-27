# GitBook

This book is plain Markdown in the repository's `gitbook/` folder. GitBook reads it through Git Sync, so the repository stays the source of truth and every change has a commit.

| File | Purpose |
| --- | --- |
| `gitbook/.gitbook.yaml` | Tells GitBook that this folder is the book, with `README.md` as the first page and `SUMMARY.md` as the navigation |
| `gitbook/SUMMARY.md` | The table of contents. A page that is not listed here does not appear in GitBook |
| `gitbook/**/*.md` | The pages. Mermaid code blocks render as diagrams in GitBook and on GitHub |
| `gitbook/gitbook-docs.yaml` | Site-level Git Sync settings: the site title and one space that reads its pages from `gitbook/`. GitBook needs it in the project directory before the first sync |

## Create the space and connect Git Sync

Do this once, after the `gitbook/` folder is on `main`.

1. Sign in at [gitbook.com](https://www.gitbook.com) and create an organisation for the project, or use the sponsor's.
2. Create a new space, for example **QC DAO handover guide**.
3. In the space header, select **Set up** next to **Git Sync**, then choose **GitHub Sync**.
4. Connect a GitHub account that can administer `0xMeePok/smu-qc-dao-project`. If the repository is not listed, install the [GitBook GitHub app](https://github.com/apps/gitbook-com) on the `0xMeePok` account and give it access to this repository.
5. Once the app is installed, set up the `main` ruleset with GitBook on its bypass list, following [Branch protection](github-actions.md#branch-protection). Without the bypass, `main` refuses every commit GitBook makes. If the first sync reports that GitBook could not push, add the bypass and sync again.
6. Under **Source repository**, choose `0xMeePok/smu-qc-dao-project` and the branch `main`.
7. For the initial sync, choose the direction from GitHub to GitBook, so the repository content replaces the empty space. Select **Swap direction** if it points the other way. Syncing from GitBook to GitHub would overwrite the book in the repository with an empty space.
8. Set **Project directory** to `gitbook`.
9. Under **Content mapping**, check that the space maps to `./`, the project directory itself. `gitbook-docs.yaml` sets this, and `.gitbook.yaml` lives there.
10. Select **Sync** and wait for the first import. Check that the navigation matches `SUMMARY.md`.
11. Publish the space and choose who can read it. A public link is fine for this public repository. Choose an invite-only space if the sponsor prefers.

GitBook's labels change from time to time. If a step looks different, GitBook's own guide is [Enabling GitHub Sync](https://gitbook.com/docs/docs-as-code/git-sync/enabling-github-sync).

## Editing the book

* **In GitBook:** merging a change request commits it to `main` through the GitBook app. Pushes that only touch `gitbook/` do not start the deploy workflow, because `deploy.yml` ignores that folder.
* **The landing page:** edit `gitbook/README.md` in the repository only. GitBook warns that editing README files in GitBook can cause conflicts or duplicate pages.
* **In a pull request:** edit the Markdown, add any new page to `SUMMARY.md`, and merge. GitBook picks up the change after the merge.
* Do not edit the same page in both places at the same time. The two edits can conflict, and one of them may need redoing.

GitBook pushes straight to `main`, so it must stay on the bypass list of the `main` ruleset. If the repository moves to another owner or organisation, reinstall the GitBook app there and add it to the bypass list again. See [Branch protection](github-actions.md#branch-protection).

## Writing style

Keep pages short, factual and current. Use British spelling. Name the file, function or setting the reader will look for, in backticks. When code changes, update the page that describes it in the same pull request.
