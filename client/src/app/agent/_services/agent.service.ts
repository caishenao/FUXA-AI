import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, firstValueFrom } from 'rxjs';
import { EndPointApi } from '../../_helpers/endpointapi';
import { HmiService, IoEventTypes } from '../../_services/hmi.service';
import {
    AgentMessage,
    AgentSelection,
    AgentSettings,
    AgentSkill,
    AgentTestResult,
    AgentTurnResult,
    AgentAttachment,
    AgentSkillMarketItem
} from '../_models/agent';

export interface AgentStreamChunk {
    sessionId: string;
    viewId: string;
    kind: 'text' | 'tool';
    delta?: string;
    name?: string;
    args?: any;
    result?: any;
}

export interface AgentDonePayload {
    sessionId: string;
    viewId: string;
    text: string;
    committed: any;
    usage: { input: number; output: number };
}

export interface AgentErrorPayload {
    sessionId: string;
    viewId: string;
    code: string;
    message: string;
}

export interface AgentSessionHistory {
    sessionId: string | null;
    viewId: string;
    messages: Array<{ id: string; role: string; content: any; createdAt: number }>;
}

@Injectable({ providedIn: 'root' })
export class AgentService implements OnDestroy {
    private base = EndPointApi.getURL();

    /** Active selection on the editor canvas (drives the panel context). */
    selection$ = new BehaviorSubject<AgentSelection | null>(null);

    /** Conversation history — single session per view in Phase 1. */
    messages$ = new BehaviorSubject<AgentMessage[]>([]);

    /** UI-side flag while a turn is in flight. */
    busy$ = new BehaviorSubject<boolean>(false);

    /** Currently active view id. */
    private activeViewId: string | null = null;

    /** Current session id (from server). */
    sessionId: string | null = null;

    /** Streamed events from socket.io. */
    stream$ = new Subject<AgentStreamChunk>();
    done$ = new Subject<AgentDonePayload>();
    error$ = new Subject<AgentErrorPayload>();
    viewUpdated$ = new Subject<{ sessionId: string; viewId: string; itemsCount: number }>();

    constructor(private http: HttpClient, private hmiService: HmiService) {
        this._bindSocketEvents();
    }

    ngOnDestroy(): void {
        // Socket listeners are on the HmiService singleton — no cleanup needed.
    }

    private _bindSocketEvents(): void {
        this.hmiService[IoEventTypes.AGENT_STREAM as any]; // ensure enum resolves
        // HmiService exposes socket as a private field. We listen via its
        // underlying socket.io connection by subscribing through the service.
        // Since HmiService doesn't expose agent events as EventEmitters yet,
        // we reach the socket directly (same pattern used internally).
        const socket = (this.hmiService as any).socket;
        if (!socket) return;

        socket.on(IoEventTypes.AGENT_STREAM, (msg: AgentStreamChunk) => {
            if (msg.viewId === this.activeViewId) {
                this.stream$.next(msg);
            }
        });
        socket.on(IoEventTypes.AGENT_DONE, (msg: AgentDonePayload) => {
            if (msg.viewId === this.activeViewId) {
                this.sessionId = msg.sessionId;
                this.done$.next(msg);
            }
        });
        socket.on(IoEventTypes.AGENT_ERROR, (msg: AgentErrorPayload) => {
            if (msg.viewId === this.activeViewId) {
                this.error$.next(msg);
            }
        });
        socket.on(IoEventTypes.AGENT_VIEW_UPDATED, (msg: { sessionId: string; viewId: string; itemsCount: number }) => {
            if (msg.viewId === this.activeViewId) {
                this.viewUpdated$.next(msg);
            }
        });
    }

    setActiveView(viewId: string | null): void {
        if (this.activeViewId !== viewId) {
            this.activeViewId = viewId;
            this.sessionId = null;
            this.messages$.next([]);
        }
    }

    setSelection(sel: AgentSelection | null): void {
        this.selection$.next(sel);
    }

    // ---- Settings ----

    getSettings(): Observable<AgentSettings> {
        return this.http.get<AgentSettings>(`${this.base}/api/agent/settings`);
    }

    saveSettings(settings: Partial<AgentSettings>): Observable<AgentSettings> {
        return this.http.put<AgentSettings>(`${this.base}/api/agent/settings`, settings);
    }

    testConnection(settings: Partial<AgentSettings>): Observable<AgentTestResult> {
        return this.http.post<AgentTestResult>(
            `${this.base}/api/agent/settings/test`,
            settings
        );
    }

    // ---- Chat ----

    sendMessage(text: string, attachments: AgentAttachment[] = []): Observable<AgentTurnResult & { sessionId?: string }> {
        if (!this.activeViewId) {
            throw new Error('Agent: no active view');
        }
        const sel = this.selection$.value;
        const body = {
            text,
            attachments,
            selection: sel && sel.viewId === this.activeViewId ? { ids: sel.ids } : undefined,
            sessionId: this.sessionId || undefined
        };
        return this.http.post<AgentTurnResult & { sessionId?: string }>(
            `${this.base}/api/agent/sessions/${this.activeViewId}/messages`,
            body
        );
    }

    pushMessage(msg: AgentMessage): void {
        this.messages$.next([...this.messages$.value, msg]);
    }

    updateMessage(id: string, patch: Partial<AgentMessage>): void {
        this.messages$.next(
            this.messages$.value.map(m => (m.id === id ? { ...m, ...patch } : m))
        );
    }

    clearMessages(): void {
        this.messages$.next([]);
    }

    // ---- Session History ----

    loadSessionHistory(): Observable<AgentSessionHistory> {
        if (!this.activeViewId) {
            throw new Error('Agent: no active view');
        }
        return this.http.get<AgentSessionHistory>(
            `${this.base}/api/agent/sessions/${this.activeViewId}`
        );
    }

    clearSessionHistory(): Observable<{ ok: boolean }> {
        if (!this.activeViewId) {
            throw new Error('Agent: no active view');
        }
        return this.http.delete<{ ok: boolean }>(
            `${this.base}/api/agent/sessions/${this.activeViewId}`
        );
    }

    // ---- Undo ----

    undo(): Observable<{ ok: boolean; viewId?: string; itemsCount?: number; reason?: string }> {
        if (!this.activeViewId) {
            throw new Error('Agent: no active view');
        }
        return this.http.post<{ ok: boolean; viewId?: string; itemsCount?: number; reason?: string }>(
            `${this.base}/api/agent/sessions/${this.activeViewId}/undo`,
            {}
        );
    }

    // ---- Skills ----

    listSkills(): Observable<AgentSkill[]> {
        return this.http.get<AgentSkill[]>(`${this.base}/api/agent/skills`);
    }

    installSkill(zip: ArrayBuffer): Observable<AgentSkill> {
        return this.http.post<AgentSkill>(`${this.base}/api/agent/skills/install`, zip, {
            headers: { 'Content-Type': 'application/zip' }
        });
    }

    setSkillEnabled(slug: string, enabled: boolean): Observable<AgentSkill> {
        return this.http.post<AgentSkill>(
            `${this.base}/api/agent/skills/${encodeURIComponent(slug)}/enable`,
            { enabled }
        );
    }

    uninstallSkill(slug: string): Observable<{ ok: boolean; slug: string }> {
        return this.http.delete<{ ok: boolean; slug: string }>(
            `${this.base}/api/agent/skills/${encodeURIComponent(slug)}`
        );
    }

    // ---- Market ----

    getMarket(): Observable<AgentSkillMarketItem[]> {
        return this.http.get<AgentSkillMarketItem[]>(`${this.base}/api/agent/skills/market`);
    }

    searchMarket(query: string, source: string = 'all'): Observable<AgentSkillMarketItem[]> {
        return this.http.get<AgentSkillMarketItem[]>(
            `${this.base}/api/agent/skills/search`,
            { params: { q: query, source } }
        );
    }

    installBySlug(slug: string, source: string = 'builtin'): Observable<AgentSkill> {
        return this.http.post<AgentSkill>(`${this.base}/api/agent/skills/install-by-slug`, { slug, source });
    }
}
