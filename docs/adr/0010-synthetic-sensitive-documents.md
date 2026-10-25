# 0010. Real resume, synthetic sensitive documents

## Decision

The resume and project notes are real. The offer letter, salary history, references and W-2 are
fictional (placeholder SSN and EIN, `example.com` contacts, made-up figures) and say so in their
first line.

## Consequences

- A bug, or a grant I should not have approved, leaks nothing real.
- The demo still shows the true shape of the problem: documents of very different sensitivity in
  one index, with one assistant in front of them.
