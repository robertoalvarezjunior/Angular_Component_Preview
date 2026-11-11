import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentMetadata } from '../analyzer/componentAnalyzer';

export class PreviewPanel {
  public static currentPanel: PreviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private port: number,
    private meta: ComponentMetadata,
    private readonly onCloseCallback: () => void,
    private readonly onRefreshCallback: () => void
  ) {
    this.panel = panel;
    this.updateContent(port, meta);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === 'refresh') {
          this.onRefreshCallback();
        }
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(
    port: number,
    meta: ComponentMetadata,
    onCloseCallback: () => void,
    onRefreshCallback: () => void
  ): PreviewPanel {
    const column = vscode.ViewColumn.Beside;

    if (PreviewPanel.currentPanel) {
      PreviewPanel.currentPanel.panel.reveal(column, true);
      PreviewPanel.currentPanel.updateContent(port, meta);
      return PreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'angularComponentLivePreview',
      `Live: ${meta.className}`,
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    PreviewPanel.currentPanel = new PreviewPanel(
      panel,
      port,
      meta,
      onCloseCallback,
      onRefreshCallback
    );
    return PreviewPanel.currentPanel;
  }

  public updateContent(port: number, meta: ComponentMetadata): void {
    this.port = port;
    this.meta = meta;
    this.panel.title = `Live: ${meta.className}`;
    this.panel.webview.html = this.getHtmlForWebview(port, meta);
  }

  public showBuildStatus(error?: string): void {
    this.panel.webview.postMessage({
      type: 'buildStatus',
      error: error || null,
    });
  }

  private getHtmlForWebview(port: number, meta: ComponentMetadata): string {
    const previewUrl = `http://127.0.0.1:${port}/?t=${Date.now()}`;
    const fileName = path.basename(meta.filePath);
    const mockedDeps =
      meta.dependencies.length > 0
        ? meta.dependencies.map((d) => d.tokenName).join(', ')
        : 'None';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Angular Component Live: ${meta.className}</title>
  <style>
    :root {
      --bg-toolbar: var(--vscode-editorWidget-background, #1e1e1e);
      --border-toolbar: var(--vscode-editorWidget-border, #333);
      --fg-text: var(--vscode-editor-foreground, #ccc);
      --accent: var(--vscode-button-background, #0e639c);
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
    .viewport-wrapper {
      flex: 1;
      display: flex;
      align-items: stretch;
      justify-content: center;
      overflow: auto;
      padding: 0;
      transition: background 0.15s ease;
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
      max-height: 160px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="badge">&lt;${meta.selector}&gt;</span>
      <span><strong>${meta.className}</strong> <span class="meta-info">(${fileName})</span></span>
      <span class="meta-info" title="Auto-Mocked DI Tokens">| DI Mocks: ${mockedDeps}</span>
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
      <button id="btn-reload" title="Reload Isolated Component">↻ Reload</button>
    </div>
  </div>
  <div id="compile-error"></div>
  <div id="canvas-container" class="viewport-wrapper bg-light">
    <iframe id="preview-frame" src="${previewUrl}"></iframe>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('preview-frame');
    const vpSelect = document.getElementById('viewport-select');
    const bgSelect = document.getElementById('bg-select');
    const container = document.getElementById('canvas-container');
    const btnReload = document.getElementById('btn-reload');
    const errorBox = document.getElementById('compile-error');

    vpSelect.addEventListener('change', () => {
      frame.className = vpSelect.value === 'full' ? '' : vpSelect.value;
    });

    bgSelect.addEventListener('change', () => {
      container.className = 'viewport-wrapper ' + bgSelect.value;
    });

    btnReload.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
      frame.src = '${previewUrl.split('?')[0]}?t=' + Date.now();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'buildStatus') {
        if (msg.error) {
          errorBox.style.display = 'block';
          errorBox.textContent = msg.error;
        } else {
          errorBox.style.display = 'none';
          errorBox.textContent = '';
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
