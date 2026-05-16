/**
 * Agent feature data model — kept narrow on purpose so the chat panel
 * doesn't have to know how the orchestrator threads tool calls together.
 */
export interface AgentSettings {
    enabled: boolean;
    provider: AgentProvider;
    baseUrl: string;
    apiKey?: string;             // '********' on read; new value on write
    apiKeyConfigured?: boolean;  // server-side flag
    chatModel: string;
    visionModel?: string;
    imageModel?: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    quota?: { perUserDailyTokens: number; perUserDailyCalls: number };
    language?: string;
}

export type AgentProvider =
    | 'openai'
    | 'openai-compatible'
    | 'anthropic'
    | 'azure-openai'
    | 'ollama'
    | 'custom';

export interface AgentTestResult {
    ok: boolean;
    latencyMs?: number;
    error?: any;
    fallback?: string;
}

export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface AgentToolCall {
    id?: string;
    name: string;
    args: any;
}

export interface AgentMessage {
    id: string;
    role: AgentMessageRole;
    text?: string;
    toolCalls?: AgentToolCall[];
    /** Tool result payload (when role === 'tool'). */
    toolResult?: any;
    /** Image attachments from the user. */
    attachments?: AgentAttachment[];
    pending?: boolean;
    error?: string;
    createdAt: number;
}

export interface AgentAttachment {
    kind: 'image';
    name: string;
    mime: string;
    /** data URL, base64-encoded — sent as-is to the orchestrator. */
    dataUrl: string;
    sizeBytes: number;
}

export interface AgentSelection {
    ids: string[];
    /** view id the selection belongs to. */
    viewId: string;
}

export interface AgentTurnResult {
    text: string;
    trace: Array<
        | { kind: 'assistant'; text: string; toolCalls: AgentToolCall[] }
        | { kind: 'tool'; name: string; args: any; result: any }
    >;
    committed: { ok: boolean; viewId?: string; itemsCount?: number; reason?: string } | null;
    usage: { input: number; output: number };
}

export type AgentSkillKind = 'tool-pack' | 'asset-pack' | 'mcp-bridge';

export interface AgentSkill {
    slug: string;
    name: string;
    version: string | null;
    kind: AgentSkillKind;
    description?: string;
    author?: string;
    enabled: boolean;
    installedAt: number | null;
    error: string | null;
}

export interface AgentSkillMarketItem {
    slug: string;
    name: string;
    version: string | null;
    kind: AgentSkillKind;
    description?: string;
    author?: string;
    source: string;         // 'builtin' | 'skills-sh'
    installed: boolean;
    enabled: boolean;
}

export interface DesignImportResult {
    fileId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    location: string;
    pages?: { name: string; width: number; height: number; elementCount: number }[];
    parseError?: string;
}
