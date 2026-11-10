Each task should be small enough to finish in one session, and
independent enough that someone who has not read the other tasks could
implement it.

Use this template for each task:

## Goal

One or two sentences on what should be true when this is done.

## Acceptance criteria

- [ ] A statement you can check by looking at the result
- [ ] One line per case, including the awkward ones

## Depends on

- #<issue> - why this task needs it first
- Or "Nothing"

## Out of scope

- Something that does not belong in this task, moved to #<issue>

## Constraints

- Files this should stay inside
- Whether it changes `backend/prisma/schema.prisma` or `openapi.yaml`
- Libraries it may not add, patterns it must follow
