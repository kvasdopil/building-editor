Read README and /docs before starting on a new task.

Never commit anything to git unless explicitly asked by user.
Do not launch dev server yourself, ask user to do that instead

## Verification

Run `yarn lint` to check if the project builds
Run `yarn format` after you're done with the code

## Memory Bank (SSoT)

The memory bank lives in `memory/` and is the single source of truth for requirements, decisions, and plans.

Annotated references:

- [memory/index.md](memory/index.md) — Main memory bank index (navigation to spec/plans/adr/mbb). Read to quickly find the SSoT for a topic and avoid creating orphan documents.
- [memory/mbb/index.md](memory/mbb/index.md) — Memory bank "bible": rules for SSoT, annotated links, duo pattern, and indexes. Read before creating new documents to follow standards and avoid duplicates.
- [memory/structure.md](memory/structure.md) — Repository structure by folders (apps/packages) and layer boundaries. Read to place code correctly and keep business logic out of UI/CLI.
- [memory/spec/index.md](memory/spec/index.md) — Specifications (WHAT). Read to implement domain rules and integrations correctly.
- [memory/adr/index.md](memory/adr/index.md) — ADRs (WHY). Read to avoid accidentally reversing decisions and to understand trade-offs.
- [memory/plans/index.md](memory/plans/index.md) — Epic/feature plans and scenarios. Read to deliver work as vertical slices with automated verification.

## Lessons Learned & Insights

During task execution, capture friction and undocumented knowledge as you go:

- **Lessons learned** (`xxx-lessons-learned.md`) — Log moments where you hit difficulties due to unclear, missing, or incorrect documentation. Anything you weren't prepared for.
- **Insights** (`xxx-insights.md`) — Log any task-relevant information that turned out to be important but wasn't documented anywhere.

Place these files in the task's working directory.

When the task is complete, process all lessons learned and insights files:

1. Identify what was undocumented, unclear, insufficiently detailed, or wrong.
2. Update the memory bank with the relevant findings.
3. Verify against MBB principles before merging — don't pull in noise, only meaningful improvements.

This creates a self-improving documentation cycle grounded in practice.

## Tools

Local cli tools like `gh`, `gcloud`, `vercel` and `supabase` are set up and configured. Use them when necessary.
