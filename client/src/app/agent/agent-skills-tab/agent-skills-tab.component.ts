import {
    Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, ViewChild, ElementRef
} from '@angular/core';
import { AgentService } from '../_services/agent.service';
import { AgentSkill, AgentSkillMarketItem } from '../_models/agent';

@Component({
    selector: 'app-agent-skills-tab',
    templateUrl: './agent-skills-tab.component.html',
    styleUrls: ['./agent-skills-tab.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class AgentSkillsTabComponent implements OnInit {
    @ViewChild('file') fileInput!: ElementRef<HTMLInputElement>;

    skills: AgentSkill[] = [];
    busy = false;
    error: string | null = null;
    info: string | null = null;
    showMarket = false;
    marketResults: AgentSkillMarketItem[] = [];
    marketLoading = false;
    marketSource = 'all';
    searchQuery = '';

    constructor(private agent: AgentService, private cdr: ChangeDetectorRef) {}

    ngOnInit(): void {
        this.reload();
    }

    reload(): void {
        this.agent.listSkills().subscribe({
            next: list => {
                this.skills = list || [];
                this.cdr.markForCheck();
            },
            error: err => {
                this.error = err?.error?.message || err?.message || 'list failed';
                this.cdr.markForCheck();
            }
        });
    }

    pick(): void {
        this.fileInput.nativeElement.click();
    }

    onFile(ev: Event): void {
        const input = ev.target as HTMLInputElement;
        const file = input.files && input.files[0];
        if (!file) return;
        if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') {
            this.error = '请选择 .zip 安装包';
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            this.error = '安装包大于 20MB';
            return;
        }
        this.error = null;
        this.info = null;
        const reader = new FileReader();
        reader.onload = () => {
            const buf = reader.result as ArrayBuffer;
            this.busy = true;
            this.cdr.markForCheck();
            this.agent.installSkill(buf).subscribe({
                next: s => {
                    this.busy = false;
                    this.info = `已安装 ${s.name} (${s.version || '-'})`;
                    input.value = '';
                    this.reload();
                },
                error: err => {
                    this.busy = false;
                    this.error = err?.error?.message || err?.message || 'install failed';
                    input.value = '';
                    this.cdr.markForCheck();
                }
            });
        };
        reader.readAsArrayBuffer(file);
    }

    toggle(s: AgentSkill): void {
        const next = !s.enabled;
        this.busy = true;
        this.agent.setSkillEnabled(s.slug, next).subscribe({
            next: updated => {
                this.busy = false;
                Object.assign(s, updated);
                this.cdr.markForCheck();
            },
            error: err => {
                this.busy = false;
                this.error = err?.error?.message || err?.message || 'toggle failed';
                this.cdr.markForCheck();
            }
        });
    }

    uninstall(s: AgentSkill): void {
        if (!confirm(`卸载 ${s.name}? 该操作不可撤销。`)) return;
        this.busy = true;
        this.agent.uninstallSkill(s.slug).subscribe({
            next: () => {
                this.busy = false;
                this.skills = this.skills.filter(x => x.slug !== s.slug);
                this.cdr.markForCheck();
            },
            error: err => {
                this.busy = false;
                this.error = err?.error?.message || err?.message || 'uninstall failed';
                this.cdr.markForCheck();
            }
        });
    }

    toggleMarket(): void {
        this.showMarket = !this.showMarket;
        if (this.showMarket && !this.marketResults.length) {
            this.loadMarket();
        }
    }

    loadMarket(): void {
        this.marketLoading = true;
        this.agent.getMarket().subscribe({
            next: list => {
                this.marketResults = list || [];
                this.marketLoading = false;
                this.cdr.markForCheck();
            },
            error: err => {
                this.marketLoading = false;
                this.error = err?.error?.message || '加载市场失败';
                this.cdr.markForCheck();
            }
        });
    }

    searchMarket(): void {
        const q = this.searchQuery.trim();
        if (!q) {
            this.loadMarket();
            return;
        }
        this.marketLoading = true;
        this.agent.searchMarket(q, this.marketSource).subscribe({
            next: list => {
                this.marketResults = list || [];
                this.marketLoading = false;
                this.cdr.markForCheck();
            },
            error: err => {
                this.marketLoading = false;
                this.error = err?.error?.message || '搜索失败';
                this.cdr.markForCheck();
            }
        });
    }

    installFromMarket(item: AgentSkillMarketItem): void {
        this.busy = true;
        this.error = null;
        this.agent.installBySlug(item.slug, item.source).subscribe({
            next: s => {
                this.busy = false;
                this.info = `已安装 ${s.name} (${s.version || '-'})`;
                item.installed = true;
                this.reload();
                this.cdr.markForCheck();
            },
            error: err => {
                this.busy = false;
                this.error = err?.error?.message || '安装失败';
                this.cdr.markForCheck();
            }
        });
    }

    kindLabel(k: string): string {
        if (k === 'tool-pack') return '工具包';
        if (k === 'asset-pack') return '资源包';
        if (k === 'mcp-bridge') return 'MCP 桥接';
        return k;
    }
}
