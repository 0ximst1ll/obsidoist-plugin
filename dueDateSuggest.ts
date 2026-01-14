import { App, Editor, Modal, Notice, SuggestModal } from 'obsidian';

type DateOption =
    | { id: 'today'; label: string; date: string }
    | { id: 'tomorrow'; label: string; date: string }
    | { id: 'week'; label: string; date: string }
    | { id: 'custom'; label: string };

function formatDateYYYYMMDD(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
}

class DateInputModal extends Modal {
    private onSubmit: (date: string) => void;

    constructor(app: App, onSubmit: (date: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: 'Select due date' });
        const input = contentEl.createEl('input', { type: 'date' });
        input.value = formatDateYYYYMMDD(new Date());
        input.focus();

        const row = contentEl.createDiv();
        const submitBtn = row.createEl('button', { text: 'Insert' });
        const cancelBtn = row.createEl('button', { text: 'Cancel' });

        submitBtn.onclick = () => {
            if (!input.value) return;
            this.onSubmit(input.value);
            this.close();
        };

        cancelBtn.onclick = () => this.close();
    }
}

export class DueDateSuggestModal extends SuggestModal<DateOption> {
    private editor: Editor;
    private insertAt: { line: number; ch: number };
    private options: DateOption[];

    constructor(app: App, editor: Editor, insertAt: { line: number; ch: number }) {
        super(app);
        this.editor = editor;
        this.insertAt = insertAt;

        const today = formatDateYYYYMMDD(new Date());
        const tomorrow = formatDateYYYYMMDD(addDays(new Date(), 1));
        const week = formatDateYYYYMMDD(addDays(new Date(), 7));

        this.options = [
            { id: 'today', label: `Today (${today})`, date: today },
            { id: 'tomorrow', label: `Tomorrow (${tomorrow})`, date: tomorrow },
            { id: 'week', label: `In 7 days (${week})`, date: week },
            { id: 'custom', label: 'Pick a date…' }
        ];

        this.setPlaceholder('Select a due date');
        (this as any).inputEl.value = '';
    }

    getSuggestions(query: string): DateOption[] {
        const q = query.trim().toLowerCase();
        if (!q) return this.options;
        return this.options.filter(o => o.label.toLowerCase().includes(q));
    }

    renderSuggestion(value: DateOption, el: HTMLElement) {
        el.setText(value.label);
    }

    onChooseSuggestion(value: DateOption) {
        if (value.id === 'custom') {
            const modal = new DateInputModal(this.app, (date) => {
                this.insertDate(date);
            });
            modal.open();
            return;
        }

        this.insertDate(value.date);
    }

    private insertDate(date: string) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            new Notice('Invalid date format. Expected YYYY-MM-DD.');
            return;
        }

        this.editor.replaceRange(date, this.insertAt);
        this.editor.setCursor({ line: this.insertAt.line, ch: this.insertAt.ch + date.length });
    }
}

