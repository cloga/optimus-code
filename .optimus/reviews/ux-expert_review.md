# UX Expert Review: Refactoring React Components

## Context
Reviewing the proposal for adding file upload capabilities to the sidebar chat interface. The current proposal lacks specific UI/UX details regarding file handling.

## Critique & Recommendations

### 1. Upload Button Placement & Behavior
*   **Critique**: The proposal does not specify where users will initiate uploads.
*   **Recommendation**:
    *   Place a **paperclip icon** inside the chat input area (left-aligned) or immediately adjacent to the send button.
    *   **Behavior**: Clicking opens the native OS file picker.
    *   **State**: The button should be disabled during active generation if uploads are not supported mid-stream.

### 2. Interaction Flow: Drag-and-Drop vs. Copy-Paste
*   **Critique**: Interaction models for file addition are undefined.
*   **Recommendation**:
    *   **Drag-and-Drop**: The **entire chat window** should act as a drop target. When a file is dragged over, display a semi-transparent overlay ("Drop to attach") to provide immediate feedback.
    *   **Copy-Paste**: Support pasting images/text files directly into the input field.
    *   **Consistency**: Both methods should result in the same "staged" file state before sending.

### 3. Sidebar Previews (Space Constraints)
*   **Critique**: Large previews will clutter the narrow VS Code sidebar.
*   **Recommendation**:
    *   Use **compact "chips"** or thumbnails placed **above the input box** (not inside the message list until sent).
    *   **Content**: Show file icon/thumbnail, truncated filename, and an "X" to remove.
    *   **Hover**: Show full filename and file size on hover.
    *   **Max Height**: Limit the attachment area to ~20% of the viewport height with a scrollbar if many files are added.

### 4. Error Handling UI
*   **Critique**: Missing error states for edge cases.
*   **Recommendation**:
    *   **Validation**: Validate immediately upon selection/drop.
    *   **Feedback**: Use **toast notifications** or inline error text (red) below the input box for issues like "File too large (>10MB)" or "Unsupported format".
    *   **Prevention**: Do not allow the message to be sent if an invalid file is attached. Disable the send button visually.

## Verdict
**Request Changes**. The proposal must be updated to include these specific UI/UX patterns to ensure a usable experience within the constrained VS Code sidebar environment.
