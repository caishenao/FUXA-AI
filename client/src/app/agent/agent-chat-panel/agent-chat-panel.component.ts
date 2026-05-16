import {
    Component, OnInit, OnDestroy, HostBinding, ChangeDetectionStrategy,
    ChangeDetectorRef, ViewChild, ElementRef
} from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { AgentService, AgentStreamChunk } from '../_services/agent.service';
import { AgentAttachment, AgentMessage, AgentSelection } from '../_models/agent';
import { ProjectService } from '../../_services/project.service';

let _id = 0;

@Component({
    selector: 'app-agent-chat-panel',
    templateUrl: './agent-chat-panel.component.html',
    styleUrls: ['./agent-chat-panel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgentChatPanelComponent implements OnInit, OnDestroy {
    @HostBinding('class.collapsed') collapsed = true;
    @ViewChild('input') input!: ElementRef<HTMLTextAreaElement>;
    @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

    messages: AgentMessage[] = [];
    selection: AgentSelection | null = null;
    busy = false;
    error: string | null = null;
    attachments: AgentAttachment[] = [];
    undoAvailable = false;
    copiedId: string | null = null;

    private destroy$ = new Subject<void>();
    private pendingAssistantId: string | null = null;
    private loopThinkingId: string | null = null;
    private hasIntermediateText = false;

    constructor(private agent: AgentService, private projectService: ProjectService, private cdr: ChangeDetectorRef) {}

    ngOnInit(): void {
        this.agent.messages$.pipe(takeUntil(this.destroy$)).subscribe(m => {
            this.messages = m;
            this.cdr.markForCheck();
            this._scrollToBottom();
        });
        this.agent.selection$.pipe(takeUntil(this.destroy$)).subscribe(s => {
            this.selection = s;
            this.cdr.markForCheck();
        });
        this.agent.busy$.pipe(takeUntil(this.destroy$)).subscribe(b => {
            this.busy = b;
            this.cdr.markForCheck();
        });

        // Streaming: progressive text + tool call display.
        this.agent.stream$.pipe(takeUntil(this.destroy$)).subscribe((chunk: AgentStreamChunk) => {
            this._handleStreamChunk(chunk);
        });

        this.agent.done$.pipe(takeUntil(this.destroy$)).subscribe(done => {
            if (this.hasIntermediateText) {
                // We showed thinking steps — add final reply as a separate message.
                if (done.text) {
                    this.agent.pushMessage({
                        id: `m${++_id}`,
                        role: 'assistant',
                        text: done.text,
                        createdAt: Date.now()
                    });
                }
                // Remove any leftover pending placeholder.
                if (this.pendingAssistantId) {
                    this.agent.updateMessage(this.pendingAssistantId, { pending: false });
                }
            } else if (this.pendingAssistantId) {
                // No intermediate text — update the pending placeholder with the reply.
                this.agent.updateMessage(this.pendingAssistantId, {
                    pending: false,
                    text: done.text || ''
                });
            }
            this.pendingAssistantId = null;
            this.loopThinkingId = null;
            this.hasIntermediateText = false;
            if (done.committed?.ok) {
                this.undoAvailable = true;
                try { this.projectService.reload(); } catch (_) { /* defensive */ }
            } else if (done.committed && !done.committed.ok) {
                this.error = done.committed.reason || '保存失败';
            }
            this.agent.busy$.next(false);
            this.cdr.markForCheck();
        });

        // Real-time view updates: reload canvas after each tool call commit.
        this.agent.viewUpdated$.pipe(takeUntil(this.destroy$)).subscribe(() => {
            this.undoAvailable = true;
            try { this.projectService.reload(); } catch (_) { /* defensive */ }
        });

        this.agent.error$.pipe(takeUntil(this.destroy$)).subscribe(err => {
            if (this.pendingAssistantId) {
                this.agent.updateMessage(this.pendingAssistantId, {
                    pending: false,
                    error: err.message || 'agent error'
                });
                this.pendingAssistantId = null;
            }
            this.agent.busy$.next(false);
            this.cdr.markForCheck();
        });
    }

    ngOnDestroy(): void {
        this.destroy$.next();
        this.destroy$.complete();
    }

    toggle(): void {
        this.collapsed = !this.collapsed;
    }

    onFileSelected(ev: Event): void {
        const target = ev.target as HTMLInputElement;
        if (!target.files) return;
        Array.from(target.files).slice(0, 4 - this.attachments.length).forEach(file => {
            if (file.size > 5 * 1024 * 1024) {
                this.error = 'image > 5MB';
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                this.attachments = [
                    ...this.attachments,
                    {
                        kind: 'image',
                        name: file.name,
                        mime: file.type,
                        dataUrl: reader.result as string,
                        sizeBytes: file.size
                    }
                ];
                this.cdr.markForCheck();
            };
            reader.readAsDataURL(file);
        });
        target.value = '';
    }

    removeAttachment(idx: number): void {
        this.attachments = this.attachments.filter((_, i) => i !== idx);
    }

    copyMessage(m: AgentMessage): void {
        const text = m.text || m.error || '';
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            this.copiedId = m.id;
            this.cdr.markForCheck();
            setTimeout(() => {
                this.copiedId = null;
                this.cdr.markForCheck();
            }, 1500);
        });
    }

    clear(): void {
        this.agent.clearMessages();
        this.attachments = [];
        this.error = null;
        this.undoAvailable = false;
        this.pendingAssistantId = null;
        this.loopThinkingId = null;
        this.hasIntermediateText = false;
        // Also clear server-side session history.
        this.agent.clearSessionHistory().subscribe({ error: () => {} });
    }

    undo(): void {
        if (this.busy) return;
        this.agent.undo().subscribe({
            next: result => {
                if (result.ok) {
                    this.undoAvailable = false;
                    try { this.projectService.reload(); } catch (_) { /* defensive */ }
                    this.agent.pushMessage({
                        id: `m${++_id}`,
                        role: 'system',
                        text: '已撤销上一次 Agent 修改',
                        createdAt: Date.now()
                    });
                } else {
                    this.error = result.reason || 'undo failed';
                }
                this.cdr.markForCheck();
            },
            error: err => {
                this.error = err?.error?.message || err?.message || 'undo failed';
                this.cdr.markForCheck();
            }
        });
    }

    send(text: string): void {
        const trimmed = (text || '').trim();
        if (!trimmed && !this.attachments.length) return;
        if (this.busy) return;
        this.error = null;

        const userMsg: AgentMessage = {
            id: `m${++_id}`,
            role: 'user',
            text: trimmed,
            attachments: this.attachments.slice(),
            createdAt: Date.now()
        };
        this.agent.pushMessage(userMsg);

        const pendingId = `m${++_id}`;
        this.pendingAssistantId = pendingId;
        this.loopThinkingId = null;
        this.hasIntermediateText = false;
        this.agent.pushMessage({
            id: pendingId,
            role: 'assistant',
            pending: true,
            createdAt: Date.now()
        });

        this.agent.busy$.next(true);
        const attachmentsToSend = this.attachments.slice();
        this.attachments = [];
        this.input.nativeElement.value = '';

        this.agent.sendMessage(trimmed, attachmentsToSend).subscribe({
            next: result => {
                // Store sessionId from server response.
                if (result.sessionId) {
                    this.agent.sessionId = result.sessionId;
                }
                // If streaming events didn't handle the response, update here.
                if (this.pendingAssistantId === pendingId) {
                    // Show intermediate thinking + tool calls from trace.
                    let showedThinking = false;
                    if (result.trace) {
                        for (const step of result.trace) {
                            if (step.kind === 'assistant' && step.text) {
                                showedThinking = true;
                                this.agent.pushMessage({
                                    id: `m${++_id}`,
                                    role: 'assistant',
                                    thinking: true,
                                    text: step.text,
                                    createdAt: Date.now()
                                });
                            } else if (step.kind === 'tool') {
                                this.agent.pushMessage({
                                    id: `m${++_id}`,
                                    role: 'tool',
                                    text: `${step.name}(${stringifyArgs(step.args)})`,
                                    toolResult: step.result,
                                    createdAt: Date.now()
                                });
                            }
                        }
                    }
                    // Final reply — update placeholder or add separate message.
                    if (showedThinking) {
                        this.agent.updateMessage(pendingId, { pending: false });
                        if (result.text) {
                            this.agent.pushMessage({
                                id: `m${++_id}`,
                                role: 'assistant',
                                text: result.text,
                                createdAt: Date.now()
                            });
                        }
                    } else {
                        this.agent.updateMessage(pendingId, {
                            pending: false,
                            text: result.text,
                            toolCalls: undefined
                        });
                    }
                    if (result.committed?.ok) {
                        this.undoAvailable = true;
                        try { this.projectService.reload(); } catch (_) { /* defensive */ }
                    } else if (result.committed && !result.committed.ok) {
                        this.error = result.committed.reason || '保存失败';
                    }
                    this.pendingAssistantId = null;
                    this.agent.busy$.next(false);
                }
                // else: streaming events already handled it.
            },
            error: err => {
                if (this.pendingAssistantId === pendingId) {
                    this.agent.updateMessage(pendingId, {
                        pending: false,
                        error: err?.error?.message || err?.message || 'request failed'
                    });
                    this.pendingAssistantId = null;
                    this.agent.busy$.next(false);
                }
            }
        });
    }

    onKey(ev: KeyboardEvent): void {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            const value = (ev.target as HTMLTextAreaElement).value;
            this.send(value);
        }
    }

    private _scrollToBottom(): void {
        requestAnimationFrame(() => {
            const el = this.scrollContainer?.nativeElement;
            if (el) { el.scrollTop = el.scrollHeight; }
        });
    }

    selectionLabel(): string {
        return this.selection && this.selection.ids.length
            ? `已选中 ${this.selection.ids.length} 个`
            : '';
    }

    private _handleStreamChunk(chunk: AgentStreamChunk): void {
        if (chunk.kind === 'text' && chunk.delta) {
            // Intermediate thinking text from the model (per loop iteration).
            // If we already have a thinking message for this loop, update it;
            // otherwise create a new one (this is a new loop iteration's thought).
            if (this.loopThinkingId) {
                this.agent.updateMessage(this.loopThinkingId, { text: chunk.delta });
            } else {
                // If there's a pending assistant placeholder, convert it to thinking.
                if (this.pendingAssistantId && !this.hasIntermediateText) {
                    this.loopThinkingId = this.pendingAssistantId;
                    this.agent.updateMessage(this.loopThinkingId, {
                        pending: false, thinking: true, text: chunk.delta
                    });
                    this.hasIntermediateText = true;
                } else {
                    const tid = `m${++_id}`;
                    this.loopThinkingId = tid;
                    this.agent.pushMessage({
                        id: tid, role: 'assistant', thinking: true,
                        text: chunk.delta, createdAt: Date.now()
                    });
                    this.hasIntermediateText = true;
                }
            }
        } else if (chunk.kind === 'tool') {
            // Reset thinking tracker for next loop iteration.
            this.loopThinkingId = null;
            this.agent.pushMessage({
                id: `m${++_id}`,
                role: 'tool',
                text: `${chunk.name}(${stringifyArgs(chunk.args)})`,
                toolResult: chunk.result,
                createdAt: Date.now()
            });
        }
        this.cdr.markForCheck();
        this._scrollToBottom();
    }
}

function stringifyArgs(a: any): string {
    try {
        const s = JSON.stringify(a);
        return s.length > 80 ? s.slice(0, 80) + '…' : s;
    } catch { return ''; }
}
