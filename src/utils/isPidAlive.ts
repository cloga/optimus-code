/**
 * Check whether a process with the given PID is still running.
 * Uses signal 0 which probes existence without sending a real signal.
 */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
