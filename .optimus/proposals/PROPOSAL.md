# RFC: Add Image Support to Chat Input Box

## Status: Draft (Waiting for Council Review)

## Context
The user wants to add image handling capabilities to the chat input box in the VS Code extension sidebar. Currently, the input box (`src/providers/ChatViewProvider.ts`) only supports text.

## Problem Statement
- Users cannot send screenshots or image files to the agent.
- No UI for file selection or drag-and-drop.
- Backend has `SessionImageAttachment` type but frontend integration is missing.

## Proposed Solution (Initial Draft)

### 1. Frontend (Webview)
- **UI Update**: Add a "paperclip" icon or image upload button near the textarea.
- **Drag & Drop**: Enable dragging images directly into the textarea.
- **Paste**: specific handler for `paste` events to catch image data from clipboard.
- **Preview**: Show small thumbnails of attached images above the input box with a "remove" (x) button.
- **Data Handling**: Convert images to Base64 in the webview before sending to the extension host.

### 2. Message Passing
- Update `doSend()` in `ChatViewProvider.ts` to include an `attachments` array in the `vscode.postMessage` payload.
- Payload structure: `{ type: 'ask', text: string, attachments: { mimeType: string, data: string }[] }`

### 3. Backend (Extension Host)
- Update `handleAsk` to process the `attachments`.
- **Option A**: Save Base64 images to a temporary folder (`.optimus/temp_images/`) and pass file paths to the LLM context.
- **Option B**: Pass Base64 data directly to the LLM (if supported).
- **Recommendation**: Start with Option A (File-based) as it works generically with most tools/prompts (using `view` tool or similar).

## Questions for Council
1.  **UX**: Where should the upload button be placed to avoid clutter?
2.  **Architecture**: Should we store images on disk (Option A) or keep in memory (Option B)? Disk seems safer for large contexts but requires cleanup.
3.  **Security**: What file size limits and type restrictions should we enforce?

## Action Plan
1.  Design UI mockup.
2.  Implement Webview changes.
3.  Implement Backend handling.
4.  Test with various image formats.
