export function truncatePromptSection(
    content: string,
    maxChars: number,
    label: string,
    guidance?: string
): string {
    const trimmed = content.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }

    const suffix = [
        '',
        `[... ${label} truncated by Optimus: ${trimmed.length - maxChars} chars omitted ...]`,
        guidance || 'Read the source file directly if you need the omitted portion.',
    ].join('\n');

    const available = Math.max(0, maxChars - suffix.length - 1);
    if (available <= 0) {
        return suffix.trim();
    }

    const head = trimmed.slice(0, available);
    const lastNewline = head.lastIndexOf('\n');
    const safeHead = lastNewline > Math.floor(available * 0.5) ? head.slice(0, lastNewline) : head;

    return `${safeHead.trimEnd()}\n${suffix}`;
}
