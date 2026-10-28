export const GUIDANCE = `# Context archive

Older conversation ranges may be replaced with archived summaries.
Message refs and archive markers are metadata, not text to repeat in replies.

<ref id="m#" kind="…"/> identifies a conversation unit.
id is its stable reference and kind its message or tool type.
A tool call and its results share one reference. Refs for assistant replies may appear
on the next user message; they describe the earlier reply, not that user's text.

<archived block="b#" range="m#–m#" topic="…">…</archived>
replaces an inclusive conversation range with the summary inside the tags.
block is the ID to restore, range identifies the originals, and topic is an optional label.
The summary is prior conversation context, not a new user request.

Archiving is automatic. You can also call archive without arguments to request cleanup
after consuming a large amount of irrelevant data (such as logs). An archive agent chooses what to summarize.

Use search_archive to find details in summaries and saved originals, then restore a block if more detail is needed.
Restoring brings back one level: original messages, or contained blocks for a nested archive.`
