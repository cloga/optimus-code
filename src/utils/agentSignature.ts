export function agentSignature(role: string, taskId?: string): string {
    const taskRef = taskId ? ` (Task: \`${taskId}\`)` : '';
    return `\n\n---\n_🤖 Created by \`${role}\`${taskRef} via Optimus Spartan Swarm_`;
}

export function agentSignatureHtml(role: string, taskId?: string): string {
    const taskRef = taskId ? ` (Task: <code>${taskId}</code>)` : '';
    return `<br><hr><p><em>🤖 Created by <code>${role}</code>${taskRef} via Optimus Spartan Swarm</em></p>`;
}
