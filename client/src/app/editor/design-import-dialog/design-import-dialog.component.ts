import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { AgentService } from '../../agent/_services/agent.service';
import { DesignImportResult } from '../../agent/_models/agent';

@Component({
    selector: 'app-design-import-dialog',
    templateUrl: './design-import-dialog.component.html',
    styleUrls: ['./design-import-dialog.component.scss']
})
export class DesignImportDialogComponent {
    file: File = null;
    fileType = '';
    previewUrl = '';
    importResult: DesignImportResult = null;
    selectedPage = 0;
    busy = false;
    error = '';

    constructor(
        public dialogRef: MatDialogRef<DesignImportDialogComponent>,
        @Inject(MAT_DIALOG_DATA) public data: any,
        private agentService: AgentService
    ) {}

    onFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const f = input.files?.[0];
        if (!f) return;
        this.file = f;
        this.error = '';
        this.importResult = null;
        this.previewUrl = '';
        this.fileType = f.name.split('.').pop()?.toLowerCase() || '';

        if (['png', 'jpg', 'jpeg'].includes(this.fileType)) {
            const reader = new FileReader();
            reader.onload = () => { this.previewUrl = reader.result as string; };
            reader.readAsDataURL(f);
        }
    }

    upload() {
        if (!this.file) return;
        this.busy = true;
        this.error = '';

        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result as string;
            this.agentService.uploadDesignFile(this.file.name, base64).subscribe({
                next: (result) => {
                    this.importResult = result;
                    this.busy = false;
                    if (['png', 'jpg', 'jpeg'].includes(this.fileType)) {
                        this.dialogRef.close({ type: 'image', location: result.location, fileId: result.fileId });
                    }
                },
                error: (err) => {
                    this.error = err?.error?.message || 'Upload failed';
                    this.busy = false;
                }
            });
        };
        reader.readAsDataURL(this.file);
    }

    importPage() {
        if (!this.importResult) return;
        this.dialogRef.close({
            type: 'pen',
            fileId: this.importResult.fileId,
            pageIndex: this.selectedPage,
            pages: this.importResult.pages
        });
    }

    cancel() {
        this.dialogRef.close();
    }
}
