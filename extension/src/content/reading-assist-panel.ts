import type { ReadingAssistKind, ReadingAssistResult } from "../shared/types";

type Locale = "zh" | "en";

export class ReadingAssistPanel {
  private readonly root: HTMLDivElement;
  private readonly locale: Locale;

  constructor(locale: Locale) {
    this.locale = locale;
    this.root = document.createElement("div");
    this.root.className = "termpop-reading-panel";
    this.root.dataset.termpopIgnore = "true";
    this.root.hidden = true;
    document.documentElement.append(this.root);
  }

  showLoading(kind: ReadingAssistKind): void {
    this.render(this.title(kind), [this.paragraph(this.text("loading"))]);
  }

  showResult(kind: ReadingAssistKind, result: ReadingAssistResult): void {
    const content: Node[] = [];
    if (kind === "summary") {
      this.addList(content, this.text("claims"), result.summary ?? []);
      this.addList(content, this.text("structure"), result.structure ?? []);
      this.addList(content, this.text("terms"), result.terms ?? []);
    } else {
      for (const item of result.items ?? []) {
        const itemRoot = document.createElement("article");
        itemRoot.className = "termpop-reading-item";
        const term = document.createElement("strong");
        term.textContent = item.term;
        const explanation = document.createElement("p");
        explanation.textContent = item.explanation;
        itemRoot.append(term, explanation);
        content.push(itemRoot);
      }
    }
    this.render(this.title(kind), content.length > 0 ? content : [this.paragraph(this.text("empty"))]);
  }

  showError(kind: ReadingAssistKind, message: string): void {
    const error = document.createElement("p");
    error.className = "termpop-reading-error";
    error.textContent = message;
    this.render(this.title(kind), [error]);
  }

  showPreview(kind: ReadingAssistKind, text: string, onConfirm: () => void): void {
    const note = document.createElement("p");
    note.textContent = this.text("previewNote");
    const excerpt = document.createElement("p");
    excerpt.className = "termpop-reading-preview";
    excerpt.textContent = text.slice(0, 600);
    const actions = document.createElement("div");
    actions.className = "termpop-reading-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = this.text("cancel");
    cancel.addEventListener("click", () => this.hide());
    const send = document.createElement("button");
    send.type = "button";
    send.className = "termpop-reading-primary";
    send.textContent = this.text("send");
    send.addEventListener("click", onConfirm);
    actions.append(cancel, send);
    this.render(this.title(kind), [note, excerpt, actions]);
  }

  hide(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private render(title: string, content: Node[]): void {
    const header = document.createElement("header");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "termpop-reading-close";
    close.setAttribute("aria-label", this.text("close"));
    close.textContent = "x";
    close.addEventListener("click", () => this.hide());
    header.append(heading, close);
    const body = document.createElement("div");
    body.className = "termpop-reading-body";
    body.append(...content);
    this.root.replaceChildren(header, body);
    this.root.hidden = false;
  }

  private addList(target: Node[], label: string, items: string[]): void {
    if (items.length === 0) return;
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = label;
    const list = document.createElement("ul");
    for (const item of items) {
      const line = document.createElement("li");
      line.textContent = item;
      list.append(line);
    }
    section.append(heading, list);
    target.push(section);
  }

  private paragraph(value: string): HTMLParagraphElement {
    const paragraph = document.createElement("p");
    paragraph.textContent = value;
    return paragraph;
  }

  private title(kind: ReadingAssistKind): string {
    return kind === "summary" ? this.text("summaryTitle") : this.text("batchTitle");
  }

  private text(key: keyof typeof copy.zh): string {
    return copy[this.locale][key];
  }
}

export const readingAssistStyles = `
.termpop-reading-panel { position: fixed; top: 18px; right: 18px; z-index: 2147483647; width: min(360px, calc(100vw - 36px)); max-height: min(70vh, 620px); overflow: hidden; border: 1px solid rgba(148, 163, 184, .34); border-radius: 12px; background: rgba(255,255,255,.98); box-shadow: 0 20px 48px rgba(15, 23, 42, .22); color: #172033; font: 14px/1.55 Inter, ui-sans-serif, system-ui, sans-serif; pointer-events: auto; }
.termpop-reading-panel header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px 14px; border-bottom:1px solid #e7edf6; }
.termpop-reading-panel header strong { font-size:15px; }
.termpop-reading-close { width:28px; height:28px; border:0; border-radius:7px; background:#f1f5f9; color:#52627d; cursor:pointer; }
.termpop-reading-body { max-height:calc(min(70vh, 620px) - 56px); overflow:auto; padding:12px 14px 15px; }
.termpop-reading-body p { margin:0 0 10px; color:#516078; }
.termpop-reading-body section + section { margin-top:13px; padding-top:12px; border-top:1px solid #eef2f7; }
.termpop-reading-body h3 { margin:0 0 6px; color:#2563eb; font-size:12px; }
.termpop-reading-body ul { margin:0; padding-left:19px; }
.termpop-reading-body li + li { margin-top:5px; }
.termpop-reading-item + .termpop-reading-item { margin-top:11px; padding-top:11px; border-top:1px solid #eef2f7; }
.termpop-reading-item strong { color:#1d4ed8; }
.termpop-reading-item p { margin:3px 0 0; }
.termpop-reading-error { color:#b91c1c !important; }
.termpop-reading-preview { max-height:150px; overflow:auto; padding:9px; border-radius:8px; background:#f8fafc; color:#475569 !important; white-space:pre-wrap; }
.termpop-reading-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
.termpop-reading-actions button { min-height:32px; padding:0 11px; border:1px solid #cbd5e1; border-radius:7px; background:#fff; color:#334155; font:inherit; cursor:pointer; }
.termpop-reading-actions .termpop-reading-primary { border-color:#2563eb; background:#2563eb; color:#fff; }
`;

const copy = {
  zh: {
    summaryTitle: "页面摘要",
    batchTitle: "批量术语解释",
    loading: "正在整理当前阅读内容...",
    claims: "核心要点",
    structure: "内容结构",
    terms: "关键术语",
    empty: "没有得到可展示的结果。",
    previewNote: "以下文本将发送给你配置的 LLM。确认后继续。",
    cancel: "取消",
    send: "发送",
    close: "关闭"
  },
  en: {
    summaryTitle: "Page summary",
    batchTitle: "Batch term explanations",
    loading: "Preparing this reading view...",
    claims: "Core points",
    structure: "Structure",
    terms: "Key terms",
    empty: "No displayable result was returned.",
    previewNote: "The text below will be sent to your configured LLM. Confirm to continue.",
    cancel: "Cancel",
    send: "Send",
    close: "Close"
  }
} as const;
