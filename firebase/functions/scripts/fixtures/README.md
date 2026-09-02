# Seed PDF fixtures

`mock_data.mjs` uploads the PDFs in this directory as the sample postings'
supporting documents.

**The PDFs themselves are gitignored on purpose.** The ones used locally are real
project documents carrying teammates' names and screenshots of private
conversations, and this repository is shared. Seeding uploads them to Cloud
Storage, where every signed-in member can download them - that is a small,
known audience. Committing them to git would be a permanent, much wider one.

To seed, drop any two PDFs here with these names:

- `scrum-status-report.pdf`
- `supervisor-meeting-notes.pdf`

The script names the missing files if either is absent.
