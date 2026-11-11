import * as vscode from 'vscode';
import { ComponentAnalyzer } from '../analyzer/componentAnalyzer';

export class AngularComponentCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor(private readonly analyzer: ComponentAnalyzer) {}

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('angularComponentPreview');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }

    if (!document.fileName.endsWith('.component.ts')) {
      return [];
    }

    const meta = this.analyzer.analyzeSource(document.fileName, document.getText());
    if (!meta) {
      return [];
    }

    const line = Math.max(0, Math.min(meta.decoratorLine, document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);

    const previewLens = new vscode.CodeLens(range, {
      title: `$(play) Angular Component Preview (${meta.className})`,
      tooltip: `Run ${meta.className} (<${meta.selector}>) in an isolated preview tab with automatic DI mocks`,
      command: 'angularComponentPreview.openPreview',
      arguments: [document.uri],
    });

    return [previewLens];
  }
}
