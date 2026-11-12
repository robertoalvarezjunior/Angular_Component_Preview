import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { ComponentMetadata } from '../analyzer/componentAnalyzer';
import { escapeHtml, jsonForInlineScript } from '../security/guards';

export class PreviewPanel {
  public static currentPanel: PreviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private previewBaseUrl: string,
    private meta: ComponentMetadata,
    private readonly onCloseCallback: () => void,
    private readonly onRefreshCallback: () => void
  ) {
    this.panel = panel;
    this.updateContent(previewBaseUrl, meta);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message && typeof message === 'object' && message.command === 'refresh') {
          this.onRefreshCallback();
        }
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(
    previewBaseUrl: string,
    meta: ComponentMetadata,
    onCloseCallback: () => void,
    onRefreshCallback: () => void
  ): PreviewPanel {
    const column = vscode.ViewColumn.Beside;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel.panel.reveal(column, true);
      PreviewPanel.currentPanel.switchComponent(previewBaseUrl, meta);
      return PreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'angularComponentPreview',
      `Preview: ${meta.className}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    PreviewPanel.currentPanel = new PreviewPanel(
      panel,
      previewBaseUrl,
      meta,
      onCloseCallback,
      onRefreshCallback
    );
    return PreviewPanel.currentPanel;
  }

  public updateContent(previewBaseUrl: string, meta: ComponentMetadata): void {
    this.previewBaseUrl = previewBaseUrl;
    this.meta = meta;
    this.panel.title = `Preview: ${meta.className}`;
    this.panel.webview.html = this.getHtmlForWebview(previewBaseUrl, meta);
  }

  /**
   * Seamlessly switches the open Webview panel to a newly selected component
   * without blanking out the whole Webview DOM or losing user's viewport/background selection.
   */
  public switchComponent(previewBaseUrl: string, meta: ComponentMetadata): void {
    const normalizedBase = previewBaseUrl.endsWith('/') ? previewBaseUrl : `${previewBaseUrl}/`;
    this.previewBaseUrl = normalizedBase;
    this.meta = meta;
    this.panel.title = `Preview: ${meta.className}`;
    this.panel.webview.postMessage({
      type: 'switchComponent',
      previewUrl: `${normalizedBase}?t=${Date.now()}`,
      previewBaseUrl: normalizedBase,
      className: meta.className,
      selector: meta.selector,
      fileName: path.basename(meta.filePath),
      mockedDeps:
        meta.dependencies.length > 0
          ? meta.dependencies.map((d) => d.tokenName).join(', ')
          : 'None',
      inputs: meta.inputs || [],
      outputs: meta.outputs || [],
    });
  }

  public updateMetadata(meta: ComponentMetadata): void {
    this.switchComponent(this.previewBaseUrl, meta);
  }

  public showBuildStatus(error?: string): void {
    this.panel.webview.postMessage({
      type: 'buildStatus',
      error: error || null,
    });
  }

  private getHtmlForWebview(previewBaseUrl: string, meta: ComponentMetadata): string {
    const normalizedBase = previewBaseUrl.endsWith('/') ? previewBaseUrl : `${previewBaseUrl}/`;
    const previewUrl = `${normalizedBase}?t=${Date.now()}`;
    const previewOrigin = new URL(normalizedBase).origin;
    const nonce = crypto.randomBytes(16).toString('base64');

    const safeClassName = escapeHtml(meta.className);
    const safeSelector = escapeHtml(meta.selector);
    const safeFileName = escapeHtml(path.basename(meta.filePath));
    const safeMockedDeps = escapeHtml(
      meta.dependencies.length > 0
        ? meta.dependencies.map((d) => d.tokenName).join(', ')
        : 'None'
    );

    const inputsJson = jsonForInlineScript(meta.inputs || []);
    const outputsJson = jsonForInlineScript(meta.outputs || []);
    const previewBaseJson = jsonForInlineScript(normalizedBase);
    const previewOriginJson = jsonForInlineScript(previewOrigin);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${previewOrigin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Angular Component Preview: ${safeClassName}</title>
  <style>
    :root {
      --bg-toolbar: var(--vscode-editorWidget-background, #1e1e1e);
      --border-toolbar: var(--vscode-editorWidget-border, #333);
      --fg-text: var(--vscode-editor-foreground, #ccc);
      --accent: var(--vscode-button-background, #0e639c);
      --panel-bg: var(--vscode-sideBar-background, #18181b);
    }
    * {
      box-sizing: border-box;
    }
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--vscode-editor-background, #121212);
      color: var(--fg-text);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--bg-toolbar);
      border-bottom: 1px solid var(--border-toolbar);
      font-size: 12px;
      gap: 8px;
      flex-wrap: wrap;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      background: rgba(221, 0, 49, 0.18);
      color: #ff4d6d;
      border: 1px solid rgba(221, 0, 49, 0.4);
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
      font-family: monospace;
    }
    .meta-info {
      opacity: 0.75;
      font-size: 11px;
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    select, button {
      background: var(--vscode-dropdown-background, #2d2d2d);
      color: var(--fg-text);
      border: 1px solid var(--border-toolbar);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground, #3a3d41);
    }
    button.active-toggle {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .viewport-wrapper {
      flex: 1;
      display: flex;
      align-items: stretch;
      justify-content: center;
      overflow: auto;
      padding: 0;
      transition: background 0.15s ease;
      min-height: 150px;
    }
    .viewport-wrapper.bg-light {
      background: #ffffff;
    }
    .viewport-wrapper.bg-dark {
      background: #18181b;
    }
    .viewport-wrapper.bg-grid {
      background-color: #ffffff;
      background-image: linear-gradient(45deg, #e5e7eb 25%, transparent 25%),
                        linear-gradient(-45deg, #e5e7eb 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #e5e7eb 75%),
                        linear-gradient(-45deg, transparent 75%, #e5e7eb 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    }
    iframe {
      border: none;
      width: 100%;
      height: 100%;
      background: transparent;
      transition: width 0.2s ease;
    }
    iframe.vp-mobile {
      width: 375px;
      border-left: 1px dashed #666;
      border-right: 1px dashed #666;
    }
    iframe.vp-tablet {
      width: 768px;
      border-left: 1px dashed #666;
      border-right: 1px dashed #666;
    }
    #compile-error {
      display: none;
      background: #7f1d1d;
      color: #fecaca;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 11px;
      white-space: pre-wrap;
      border-bottom: 1px solid #ef4444;
      max-height: 140px;
      overflow: auto;
    }

    /* Interactive @Input / @Output Dock */
    .devtools-dock {
      height: 250px;
      background: var(--panel-bg);
      border-top: 1px solid var(--border-toolbar);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .devtools-dock.collapsed {
      display: none;
    }
    .dock-tabs {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg-toolbar);
      border-bottom: 1px solid var(--border-toolbar);
      padding: 0 10px;
      height: 32px;
    }
    .dock-tab-list {
      display: flex;
      gap: 4px;
      height: 100%;
    }
    .dock-tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 0 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-text);
      opacity: 0.7;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dock-tab:hover {
      opacity: 1;
      background: rgba(255,255,255,0.04);
    }
    .dock-tab.active {
      opacity: 1;
      border-bottom-color: #ff4d6d;
      color: #fff;
    }
    .pill-count {
      background: rgba(255,255,255,0.12);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
    }
    .pill-count.highlight {
      background: #10b981;
      color: #052e16;
      font-weight: 700;
    }
    .dock-body {
      flex: 1;
      overflow: auto;
      padding: 10px 12px;
    }
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }
    .controls-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .controls-table th {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-toolbar);
      opacity: 0.7;
      font-weight: 600;
      font-size: 11px;
    }
    .controls-table td {
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      vertical-align: top;
    }
    .prop-name {
      font-family: monospace;
      font-weight: 600;
      color: #60a5fa;
    }
    .prop-req {
      color: #f87171;
      font-size: 10px;
      margin-left: 4px;
    }
    .prop-type {
      font-family: monospace;
      font-size: 11px;
      color: #a78bfa;
    }
    .control-input {
      width: 100%;
      background: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #eee);
      border: 1px solid var(--border-toolbar);
      border-radius: 4px;
      padding: 4px 8px;
      font-family: monospace;
      font-size: 11px;
    }
    .control-input:focus {
      outline: 1px solid var(--accent);
    }
    textarea.control-input {
      min-height: 54px;
      resize: vertical;
    }
    .empty-msg {
      opacity: 0.6;
      font-size: 12px;
      padding: 12px 4px;
      font-style: italic;
    }
    .events-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: monospace;
      font-size: 11px;
    }
    .event-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      background: rgba(255,255,255,0.03);
      border-left: 3px solid #10b981;
      border-radius: 3px;
    }
    .event-time {
      opacity: 0.55;
      flex-shrink: 0;
    }
    .event-name {
      color: #34d399;
      font-weight: 600;
      flex-shrink: 0;
    }
    .event-payload {
      color: #e5e7eb;
      word-break: break-all;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <span id="hdr-selector" class="badge">&lt;${safeSelector}&gt;</span>
      <span><strong id="hdr-classname">${safeClassName}</strong> <span id="hdr-filename" class="meta-info">(${safeFileName})</span></span>
      <span id="hdr-dimocks" class="meta-info" title="Auto-Mocked DI Tokens">| DI Mocks: ${safeMockedDeps}</span>
    </div>
    <div class="toolbar-actions">
      <select id="viewport-select" title="Viewport Size">
        <option value="full">Viewport: 100%</option>
        <option value="vp-tablet">Tablet (768px)</option>
        <option value="vp-mobile">Mobile (375px)</option>
      </select>
      <select id="bg-select" title="Canvas Background">
        <option value="bg-light">Background: Light</option>
        <option value="bg-dark">Background: Dark</option>
        <option value="bg-grid">Background: Grid</option>
      </select>
      <button id="btn-toggle-dock" class="active-toggle" title="Toggle @Input / @Output Panel">⚙ Inputs / Outputs</button>
      <button id="btn-reload" title="Reload Isolated Component">↻ Reload</button>
    </div>
  </div>
  <div id="compile-error"></div>
  <div id="canvas-container" class="viewport-wrapper bg-light">
    <iframe id="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" src="${previewUrl}"></iframe>
  </div>

  <!-- Interactive @Input() / @Output() Panel -->
  <div id="devtools-dock" class="devtools-dock">
    <div class="dock-tabs">
      <div class="dock-tab-list">
        <button class="dock-tab active" data-tab="tab-inputs">
          @Input() Controls <span id="input-count-badge" class="pill-count">${meta.inputs.length}</span>
        </button>
        <button class="dock-tab" data-tab="tab-outputs">
          @Output() Events <span id="output-count-badge" class="pill-count">0</span>
        </button>
      </div>
      <div>
        <button id="btn-clear-events" style="display:none; font-size:10px; padding:2px 6px;">Clear Log</button>
      </div>
    </div>

    <div class="dock-body">
      <!-- @Input() Tab -->
      <div id="tab-inputs" class="tab-pane active">
        <div id="inputs-container"></div>
      </div>

      <!-- @Output() Tab -->
      <div id="tab-outputs" class="tab-pane">
        <div id="outputs-meta" style="margin-bottom: 8px; font-size: 11px; opacity: 0.75;"></div>
        <div id="events-log" class="events-list">
          <div class="empty-msg">Interact with the component above to see emitted @Output() events in real time...</div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('preview-frame');
    const vpSelect = document.getElementById('viewport-select');
    const bgSelect = document.getElementById('bg-select');
    const container = document.getElementById('canvas-container');
    const btnReload = document.getElementById('btn-reload');
    const btnToggleDock = document.getElementById('btn-toggle-dock');
    const dock = document.getElementById('devtools-dock');
    const errorBox = document.getElementById('compile-error');
    const inputsContainer = document.getElementById('inputs-container');
    const outputsMetaContainer = document.getElementById('outputs-meta');
    const eventsLog = document.getElementById('events-log');
    const inputBadge = document.getElementById('input-count-badge');
    const outputBadge = document.getElementById('output-count-badge');
    const btnClearEvents = document.getElementById('btn-clear-events');
    const hdrSelector = document.getElementById('hdr-selector');
    const hdrClassName = document.getElementById('hdr-classname');
    const hdrFileName = document.getElementById('hdr-filename');
    const hdrDiMocks = document.getElementById('hdr-dimocks');

    let previewBaseUrl = ${previewBaseJson};
    const previewOrigin = ${previewOriginJson};
    let componentInputs = ${inputsJson};
    let componentOutputs = ${outputsJson};
    let emittedCount = 0;

    // Render @Input() Controls Table
    function renderInputControls(initialValues = {}) {
      if (!componentInputs || componentInputs.length === 0) {
        inputsContainer.innerHTML = '<div class="empty-msg">No @Input() or input() properties detected on this component.</div>';
        return;
      }

      let html = '<table class="controls-table"><thead><tr><th style="width:28%">Name</th><th style="width:22%">Type</th><th>Live Value</th></tr></thead><tbody>';
      for (const inp of componentInputs) {
        const displayName = inp.alias && inp.alias !== inp.name ? inp.name + ' (' + inp.alias + ')' : inp.name;
        const reqBadge = inp.required ? '<span class="prop-req">*required</span>' : '';
        const typeLabel = inp.rawType || inp.type || 'any';
        const currentVal =
          initialValues && Object.prototype.hasOwnProperty.call(initialValues, inp.name)
            ? initialValues[inp.name]
            : undefined;

        html += '<tr>';
        html += '<td><span class="prop-name">@Input() ' + escapeHtml(displayName) + '</span>' + reqBadge + '</td>';
        html += '<td><span class="prop-type">' + escapeHtml(typeLabel) + '</span></td>';
        html += '<td>' + renderControlWidget(inp, currentVal) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      inputsContainer.innerHTML = html;

      // Attach listeners
      inputsContainer.querySelectorAll('[data-input-name]').forEach((el) => {
        const inputName = el.getAttribute('data-input-name');
        const inputType = el.getAttribute('data-input-type');

        const sendUpdate = () => {
          let parsedValue;
          if (inputType === 'boolean') {
            parsedValue = el.checked;
          } else if (inputType === 'number') {
            parsedValue = Number(el.value);
          } else if (inputType === 'object' || inputType === 'array') {
            try {
              parsedValue = JSON.parse(el.value);
              el.style.borderColor = '';
            } catch (e) {
              el.style.borderColor = '#ef4444';
              return;
            }
          } else {
            parsedValue = el.value;
          }

          frame.contentWindow?.postMessage({
            type: 'NG_LIVE_SET_INPUT',
            name: inputName,
            value: parsedValue,
          }, previewOrigin);
        };

        el.addEventListener('input', sendUpdate);
        el.addEventListener('change', sendUpdate);
      });
    }

    function renderControlWidget(inp, currentVal) {
      const effectiveVal = currentVal !== undefined ? currentVal : inp.sampleValue;
      const nameAttr = 'data-input-name="' + escapeHtml(inp.name) + '" data-input-type="' + escapeHtml(inp.type) + '"';
      if (inp.type === 'boolean') {
        const isChecked = effectiveVal === true || (effectiveVal === undefined && inp.defaultValueExpr === 'true');
        return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" ' + nameAttr + (isChecked ? ' checked' : '') + ' /> <span>boolean</span></label>';
      }
      if (inp.type === 'number') {
        const val = effectiveVal !== undefined ? effectiveVal : 1;
        return '<input type="number" class="control-input" ' + nameAttr + ' value="' + escapeHtml(String(val)) + '" />';
      }
      if (inp.type === 'object' || inp.type === 'array') {
        const jsonStr = effectiveVal !== undefined ? JSON.stringify(effectiveVal, null, 2) : (inp.type === 'array' ? '[]' : '{}');
        return '<textarea class="control-input" ' + nameAttr + '>' + escapeHtml(jsonStr) + '</textarea>';
      }
      const strVal = effectiveVal !== undefined ? String(effectiveVal) : ('Sample ' + inp.name);
      return '<input type="text" class="control-input" ' + nameAttr + ' value="' + escapeHtml(strVal) + '" />';
    }

    function renderOutputsHeader() {
      if (!componentOutputs || componentOutputs.length === 0) {
        outputsMetaContainer.innerHTML = 'Declared @Output()s: <em>None detected</em>';
      } else {
        const names = componentOutputs.map((o) => '<code>(' + escapeHtml(o.alias || o.name) + ')</code>').join(', ');
        outputsMetaContainer.innerHTML = 'Listening to @Output()s: ' + names;
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    renderInputControls();
    renderOutputsHeader();

    // Tab switching
    document.querySelectorAll('.dock-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        document.querySelectorAll('.dock-tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
        tabBtn.classList.add('active');
        const targetId = tabBtn.getAttribute('data-tab');
        document.getElementById(targetId)?.classList.add('active');
        btnClearEvents.style.display = targetId === 'tab-outputs' ? 'inline-block' : 'none';
        if (targetId === 'tab-outputs') {
          outputBadge.classList.remove('highlight');
        }
      });
    });

    btnToggleDock.addEventListener('click', () => {
      dock.classList.toggle('collapsed');
      btnToggleDock.classList.toggle('active-toggle');
    });

    btnClearEvents.addEventListener('click', () => {
      emittedCount = 0;
      outputBadge.textContent = '0';
      outputBadge.classList.remove('highlight');
      eventsLog.innerHTML = '<div class="empty-msg">Interact with the component above to see emitted @Output() events in real time...</div>';
    });

    vpSelect.addEventListener('change', () => {
      frame.className = vpSelect.value === 'full' ? '' : vpSelect.value;
    });

    bgSelect.addEventListener('change', () => {
      container.className = 'viewport-wrapper ' + bgSelect.value;
    });

    btnReload.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
      frame.src = previewBaseUrl + '?t=' + Date.now();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      const fromIframe = event.origin === previewOrigin && event.source === frame.contentWindow;

      if (msg.type === 'buildStatus' && !fromIframe) {
        if (msg.error) {
          errorBox.style.display = 'block';
          errorBox.textContent = msg.error;
        } else {
          errorBox.style.display = 'none';
          errorBox.textContent = '';
        }
      } else if (msg.type === 'switchComponent' && !fromIframe) {
        previewBaseUrl = msg.previewBaseUrl || previewBaseUrl;
        componentInputs = msg.inputs || [];
        componentOutputs = msg.outputs || [];
        hdrSelector.textContent = '<' + (msg.selector || '') + '>';
        hdrClassName.textContent = msg.className || '';
        hdrFileName.textContent = '(' + (msg.fileName || '') + ')';
        hdrDiMocks.textContent = '| DI Mocks: ' + (msg.mockedDeps || 'None');
        inputBadge.textContent = String(componentInputs.length);
        emittedCount = 0;
        outputBadge.textContent = '0';
        outputBadge.classList.remove('highlight');
        eventsLog.innerHTML = '<div class="empty-msg">Interact with the component above to see emitted @Output() events in real time...</div>';
        errorBox.style.display = 'none';
        errorBox.textContent = '';
        renderInputControls();
        renderOutputsHeader();
        frame.src = msg.previewUrl || (previewBaseUrl + '?t=' + Date.now());
      } else if (fromIframe && msg.type === 'NG_LIVE_INITIAL_INPUTS') {
        renderInputControls(msg.values || {});
      } else if (fromIframe && msg.type === 'NG_LIVE_OUTPUT_EMITTED') {
        if (emittedCount === 0) {
          eventsLog.innerHTML = '';
        }
        emittedCount++;
        outputBadge.textContent = String(emittedCount);
        outputBadge.classList.add('highlight');

        const row = document.createElement('div');
        row.className = 'event-row';
        const rawPayload = typeof msg.payload === 'object' ? JSON.stringify(msg.payload) : String(msg.payload);
        const payloadStr = rawPayload.length > 2000 ? rawPayload.slice(0, 2000) + '…' : rawPayload;
        row.innerHTML =
          '<span class="event-time">[' + escapeHtml(msg.timestamp || '') + ']</span>' +
          '<span class="event-name">(' + escapeHtml(msg.alias || msg.name) + ')</span>' +
          '<span class="event-payload">→ ' + escapeHtml(payloadStr) + '</span>';
        eventsLog.prepend(row);
        while (eventsLog.children.length > 100) {
          eventsLog.lastElementChild?.remove();
        }
      }
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    PreviewPanel.currentPanel = undefined;
    this.onCloseCallback();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
