# Agent Note: LivingDiary migration to ChatLuna v2

Status: proposed

## Problem

LivingDiary publishes to a real QQ account. In v2 a tool call can name another speaker in the same turn. Membership in the conversation does not establish permission to post. Two v1 implementation details also conflict with the intended behavior: the SDK does not receive the account recovered from login info, and the daily digest reads only the first page of memories.

## Proposal

Authorize `qzone_publish` for the actual requester. Another speaker cannot lend their identity or their allowlist entry. Without an identifiable, authorized requester the tool must not write. This rule concerns conversational publishing; scheduled diary entries and automatic interactions keep their own entry points.

Pass the cookies and resolved account ID together both when creating the SDK client and when rebinding its session. For the digest, select active memories for the configured preset created between local midnight and the start of the run. Select the newest configured number by creation time, then pass them to the model oldest first.

Each plugin instance selects one Qzone persona preset. The daily diary reads that preset's memories and writes in its voice; automatic comments and replies use the same voice. The diary and interactions can use different models. Conversational `qzone_publish` sends the text supplied by the current conversation through the normal publishing path without asking the Qzone persona to rewrite it.

## Alternatives considered

**Authorize the named speaker.** This would let Bob publish using Alice's permission merely because she spoke during the same turn.

**Copy v1 calls unchanged.** A valid ticket without an embedded account ID can fail even after the adapter identified the account. Reading only the first page ordered by update time can omit today's entries in favor of older entries edited today.

## Acceptance criteria

With only Alice allowlisted, Alice can request a post. Bob cannot post as Alice even when both spoke in the turn. An unidentifiable caller causes zero writes. Use a fake SDK to check actual write counts.

Use a ticket without an embedded account ID and an adapter that supplies it. Verify that the SDK receives the resolved ID on both client creation and rebind.

For a limit of 100, mix more than 100 active entries created today with archived entries and older entries edited today. The model receives exactly the newest 100 eligible entries in chronological order, regardless of page boundaries.

Configure the plugin with preset A and a group chat with preset B. A diary run uses A's memories and persona, and an automatic reply uses A's persona with the interaction model. A publishing tool call in the group uses the submitted text without an additional model call.

## Risks

The framework can resolve a tool's actor after processing a delegated subject. An integration test must distinguish the original requester from that substituted identity. The SDK and digest cases can be verified without posting to QQ.

Verified with one group alternating between unauthorized and authorized users: after an authorized turn, the framework can retain the tool name and schema in the model's cached request. The live tool is absent on the next unauthorized turn, and execution is denied.

## Migration progress

- [x] Space commands and conversational publishing: build the plugin, verify the caller allowlist and the SDK write count with a simulated publisher, and read one real self-feed entry using the configured OneBot account. Milky has adapter tests; live Milky verification is pending.
- [x] Daily diary: manual and scheduled runs share one task per instance. Tested chat and character presets, selection of the newest 100 of 120 eligible memories, cancellation, and single writes with a simulated publisher. Verified the v2 model runtime with a simulated provider.
- [ ] Automatic interactions: migrate polling, comment thread selection, media handling, and cancellation.
