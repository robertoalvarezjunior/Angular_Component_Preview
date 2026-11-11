import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentAnalyzer, ComponentMetadata } from './analyzer/componentAnalyzer';
import { SandboxGenerator } from './sandbox/sandboxGenerator';
import { PreviewServer } from './server/previewServer';
import { AngularComponentCodeLensProvider } from './providers/codeLensProvider';
import { PreviewPanel } from './webview/previewPanel';

let previewServer: PreviewServer | null = null;
let currentMetadata: ComponentMetadata | null = null;

export function activate(context: vscode.ExtensionContext) {
  const analyzer = new ComponentAnalyzer();
  const sandboxGenerator = new SandboxGenerator();
  previewServer = new PreviewServer();

  // 1. Register CodeLens above @Component decorators
  const codeLensProvider = new AngularComponentCodeLensProvider(analyzer);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'typescript', pattern: '**/*.component.ts' },
      codeLensProvider
    )
  );

  // 2. Register command to launch isolated live preview
  const openPreviewCommand = vscode.commands.registerCommand(
    'angularComponentLive.openPreview',
    async (uri?: vscode.Uri) => {
      const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        vscode.window.showWarningMessage(
          'Angular Component Live: Open an Angular .component.ts file first.'
        );
        return;
      }

      const filePath = targetUri.fsPath;
      if (!filePath.endsWith('.component.ts')) {
        vscode.window.showWarningMessage(
          'Angular Component Live: Selected file is not an Angular .component.ts file.'
        );
        return;
      }

      await launchIsolatedPreview(filePath, analyzer, sandboxGenerator);
    }
  );

  // 3. Register manual refresh command
  const refreshPreviewCommand = vscode.commands.registerCommand(
    'angularComponentLive.refreshPreview',
    async () => {
      if (currentMetadata) {
        await launchIsolatedPreview(currentMetadata.filePath, analyzer, sandboxGenerator);
      }
    }
  );

  // 4. Watch for saves on `.component.html`, `.component.scss`, `.component.css`, and `.component.ts`
  // so that external template/style changes or newly added DI services update live.
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!currentMetadata || !previewServer || !PreviewPanel.currentPanel) {
      return;
    }

    const savedPath = doc.uri.fsPath;
    const activeComponentDir = path.dirname(currentMetadata.filePath);

    if (savedPath === currentMetadata.filePath) {
      // Re-analyze component in case new services were injected or selector/inputs changed
      const updatedMeta = analyzer.analyzeFile(savedPath);
      if (updatedMeta) {
        currentMetadata = updatedMeta;
        const config = vscode.workspace.getConfiguration('angularComponentLive');
        const autoMock = config.get<boolean>('autoMockServices', true);
        sandboxGenerator.generateSandbox(updatedMeta, autoMock);
      }
      await previewServer.triggerRebuild();
    } else if (
      savedPath.startsWith(activeComponentDir) &&
      (savedPath.endsWith('.html') || savedPath.endsWith('.scss') || savedPath.endsWith('.css') || savedPath.endsWith('.sass'))
    ) {
      // Trigger rebuild to re-inline updated HTML template or SCSS styles
      await previewServer.triggerRebuild();
    }
  });

  context.subscriptions.push(openPreviewCommand, refreshPreviewCommand, saveListener);
}

async function launchIsolatedPreview(
  componentFilePath: string,
  analyzer: ComponentAnalyzer,
  sandboxGenerator: SandboxGenerator
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Angular Component Live: Isolating ${path.basename(componentFilePath)}...`,
      cancellable: false,
    },
    async () => {
      try {
        const meta = analyzer.analyzeFile(componentFilePath);
        if (!meta) {
          vscode.window.showErrorMessage(
            `Angular Component Live: Could not find an @Component class in ${path.basename(componentFilePath)}.`
          );
          return;
        }

        currentMetadata = meta;
        const config = vscode.workspace.getConfiguration('angularComponentLive');
        const autoMock = config.get<boolean>('autoMockServices', true);
        const preferredPort = config.get<number>('port', 0);

        const sandbox = sandboxGenerator.generateSandbox(meta, autoMock);

        if (!previewServer) {
          previewServer = new PreviewServer();
        }

        const port = await previewServer.startOrUpdate(
          sandbox,
          preferredPort,
          (buildError) => {
            PreviewPanel.currentPanel?.showBuildStatus(buildError);
          }
        );

        PreviewPanel.createOrShow(
          port,
          meta,
          () => {
            // Stop server when preview tab is closed to free resources
            previewServer?.stop();
            currentMetadata = null;
          },
          async () => {
            if (currentMetadata) {
              const refreshedMeta = analyzer.analyzeFile(currentMetadata.filePath) || currentMetadata;
              sandboxGenerator.generateSandbox(refreshedMeta, autoMock);
              await previewServer?.triggerRebuild();
            }
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Angular Component Live failed: ${err?.message || String(err)}`
        );
      }
    }
  );
}

export async function deactivate() {
  if (previewServer) {
    await previewServer.stop();
    previewServer = null;
  }
}
