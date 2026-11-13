# Agent Note: Diary history and writing material

Status: implemented

## Problem

A generated diary can outlive its QQ post. Logs and the online feed cannot reliably show what was written, which memories were available to the writer, or how the material read before later edits.

## Decision

Save each completed diary in the instance database before submitting it to QQ. Keep the preset, diary date, writing time, full text and an ordered copy of the memory IDs and texts supplied to the model. A new run produces a separate entry even on the same date. A run without a diary produces no entry.

Record the publication outcome separately. A saved diary remains unpublished until a publication attempt starts. Publish it once and count it as published only if the post is retrieved by the ID in the receipt. A feed entry with identical text does not identify this write. Every other attempted outcome counts as failed. The console groups diaries by preset, shows the selected entry beside its writing material and uses the framework's plugin editor for configuration.

## Alternatives considered

Storing memory IDs alone makes old entries depend on edits and deletions in LivingMemory. Asking the model to annotate citations would answer a different question: the journal records its input, not which sentences it chose to paraphrase.

## Consequences

The journal duplicates a bounded set of memory texts for each entry. Readers can still consult them after the source changes, the plugin restarts or the QQ write fails.
