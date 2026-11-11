# Agent Note: LivingDiary migration to ChatLuna v2

Status: implemented

## Problem

LivingDiary writes to a real QQ account. ChatLuna v2 tools can name a different speaker in the same turn, and later polls can rediscover the same post or comment. Both paths need a clear owner for each public write.

## Decision

The conversational publishing tool authorizes the actual requester and sends their submitted text. Background jobs use the configured space persona. The diary reads LivingMemory and uses the diary model; automatic interactions use their own model and QQ allowlist. Neither background job uses the persona of the group that last spoke.

The SDK receives both cookies and the resolved QQ account on initialization and rebind. A failed read may be retried after a rebind. A submitted write is never replayed automatically.

The diary selects active memories created between local midnight and the start of the run. It takes the newest configured number by creation time and passes them to the model oldest first.

Polling records existing posts and comments as history on startup. New comments are eligible on the bot's own posts and in its explicitly identified top-level threads on friends' posts. The model decides whether to write and supplies the text; the plugin selects the destination from a complete comment snapshot and calls the SDK.

The bot's posts come from the bound account's profile: the SDK's home feed also contains friends' posts. Only a normally completed model call may authorize a write. Automatic image reads use Qzone photo hosts, check each redirect, and count failed reads toward the same byte budget as successful reads.

## Alternatives considered

**Trust the speaker named in the tool call.** A requester could then borrow another participant's permission to post.

**Use the first page of memories or select by update time.** Old memories edited today could displace entries actually created today.

**Recover missed interactions after a restart or retry an uncertain write.** Either can send stale or duplicate public replies. Poll state lasts for the lifetime of the plugin instance.

## Consequences

While enabled, `qzone_publish` stays in the tool catalog even with an empty allowlist. Changing speakers leaves its definition unchanged. At execution, the framework's tool permission applies, and LivingDiary checks the requesting QQ account against the allowlist and rejects calls on behalf of a different speaker. Uncertain writes remain visible in the status report. Incomplete comment snapshots defer the decision until a later poll.

## Verification

- [x] Space commands and tools: requester authorization, SDK account binding and write counts checked. One real OneBot self-feed read was verified; Milky has adapter tests.
- [x] Daily diary: tests cover manual and scheduled runs, both persona kinds, creation-time selection across the local day boundary and single writes.
- [x] Automatic interactions: simulated feeds and a simulated model provider cover startup history, allowlists, thread routing, write limits and cancellation. No live QQ writes were made.
