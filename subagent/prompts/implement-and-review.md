---
description: Worker implements test-first (TDD), reviewer reviews test evidence, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement test-first (TDD): $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder). The reviewer must check the worker's `## Test Evidence` for RED/GREEN results.
3. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
