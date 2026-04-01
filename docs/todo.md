# Planned features and bugfixes
## Feature Extensions
- [ ] Google Gemini built-in "code execution" tool can run Python code and render graphics using it. Add support for it.

## Technical Extensions
- [ ] `inline` mode would benefit from a disk file cache.
- [x] Redirect resolution for `vertexaisearch` sources URLs now happens on every Sources button retrieval. Add an LRU cache for it.
- [ ] `ChatClient` interfaces implementations construct sub-objects eagerly, when doing it lazily would suffice and it would be more efficient.
- [x] Update dependencies.
- [ ] Ephemeral responses disappear on changing channels or "Jumping to newest message", making exports and sources on older bot messages currently unviewable. One solution would be to send them as a DM on a sufficiently old message. But DMs can fail to be delivered too. Another fallback would be a Modal display with text content. But modals can't display attachments. If a file output is needed (like in the case of Export commands), a non-ephemeral reply might be needed as the last fallback. Finding the right time threshold after which a message is "many pages above newest in channel" is also challenging to do universally as it depends on per-channel activity. A per channel timestamped message counter would be necessary for a deterministic condition (e.g. more than 10 new messages in channel).   

## Bugfixes
- [x] Triage model sometimes calls video / URL fetch content tool on URLs with content already in the history chain. These calls can (and should be) be filtered programatically instead of doubling data unnecessarily in the conversation history.