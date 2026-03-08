/**
 * Shared ANSI escape-code regex used across adapters.
 * Matches CSI sequences, OSC, and single-byte C1 escapes.
 */
export const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
