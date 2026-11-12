import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ComponentAnalyzer, ComponentMetadata } from './analyzer/componentAnalyzer';
import { SandboxGenerator } from './sandbox/sandboxGenerator';
import { PreviewServer } from './server/previewServer';
import { AngularComponentCodeLensProvider } from './providers/codeLensProvider';
import { PreviewPanel } from './webview/previewPanel';
import { isPathInside } from './security/guards';

let previewServer: PreviewServer | null = null;
let currentMetadata: ComponentMetadata | null = null;

/**
 * Given any Angular component file (`.component.ts`, `.component.html`, `.component.scss`, `.html`, `.scss`, `.css`, etc.),
 * resolves the companion TypeScript component file containing the `@Component` decorator.
 */
function resolveComponentTsPath(inputPath: string): string | null {
  if (inputPath.endsWith('.ts') && !inputPath.endsWith('.spec.ts') && !inputPath.endsWith('.d.ts')) {
    return fs.existsSync(inputPath) ? inputPath : null;
  }

  const dir = path.dirname(inputPath);
  const baseName = path.basename(inputPath);

  // 1. Direct stem match (e.g. `foo.component.html` -> `foo.component.ts` or `app.html` -> `app.ts`)
  const stem = baseName.replace(/\.(html|htm|scss|css|sass|less)$/i, '');
  const directCandidates = [
    path.join(dir, `${stem}.ts`),
    path.join(dir, `${stem}.component.ts`),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Fallback: look for any `.component.ts` or `@Component` file in the same directory
  try {
    const files = fs.readdirSync(dir);
    const componentTs = files.find(
      (f) => f.endsWith('.component.ts') && !f.endsWith('.spec.component.ts')
    );
    if (componentTs) {
      return path.join(dir, componentTs);
    }

    const anyComponentTs = files.find((f) => {
      if (!f.endsWith('.ts') || f.endsWith('.spec.ts') || f.endsWith('.d.ts') || f.endsWith('.model.ts')) {
        return false;
      }
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        return content.includes('@Component');
      } catch {
        return false;
      }
    });
    if (anyComponentTs) {
      return path.join(dir, anyComponentTs);
    }
  } catch {
    // ignore
  }

  return null;
}

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

  // 2. Register command to launch isolated live preview (from .ts, .html, .scss, .css, .sass, .less)
  const openPreviewCommand = vscode.commands.registerCommand(
    'angularComponentPreview.openPreview',
    async (uri?: vscode.Uri) => {
      const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        vscode.window.showWarningMessage(
          'Angular Component Preview: Open an Angular component file (.ts, .html, .scss, .css) first.'
        );
        return;
      }

      const resolvedTsPath = resolveComponentTsPath(targetUri.fsPath);
      if (!resolvedTsPath) {
        vscode.window.showWarningMessage(
          `Angular Component Preview: Could not find a companion Angular .component.ts file for ${path.basename(targetUri.fsPath)}.`
        );
        return;
      }

      await launchIsolatedPreview(resolvedTsPath, analyzer, sandboxGenerator);
    }
  );

  // 3. Register manual refresh command
  const refreshPreviewCommand = vscode.commands.registerCommand(
    'angularComponentPreview.refreshPreview',
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
      // Re-analyze component in case new services were injected or selector/inputs/outputs changed
      const updatedMeta = analyzer.analyzeFile(savedPath);
      if (updatedMeta) {
        const ioChanged =
          JSON.stringify(updatedMeta.inputs) !== JSON.stringify(currentMetadata.inputs) ||
          JSON.stringify(updatedMeta.outputs) !== JSON.stringify(currentMetadata.outputs);
        currentMetadata = updatedMeta;
        const config = vscode.workspace.getConfiguration('angularComponentPreview');
        const autoMock = config.get<boolean>('autoMockServices', true);
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(savedPath))?.uri.fsPath;
        const updatedSandbox = sandboxGenerator.generateSandbox(
          updatedMeta,
          autoMock,
          previewServer.getSessionToken(),
          workspaceRoot
        );
        previewServer.updateSandbox(updatedSandbox);
        if (ioChanged) {
          PreviewPanel.currentPanel.updateMetadata(updatedMeta);
        }
      }
      await previewServer.triggerRebuild();
    } else if (
      isPathInside(activeComponentDir, savedPath) &&
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
  if (vscode.workspace.isTrusted === false) {
    vscode.window.showErrorMessage(
      'Angular Component Preview requires a trusted workspace to compile and execute Angular components.'
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Angular Component Preview: Isolating ${path.basename(componentFilePath)}...`,
      cancellable: false,
    },
    async () => {
      try {
        const meta = analyzer.analyzeFile(componentFilePath);
        if (!meta) {
          vscode.window.showErrorMessage(
            `Angular Component Preview: Could not find an @Component class in ${path.basename(componentFilePath)}.`
          );
          return;
        }

        currentMetadata = meta;
        const config = vscode.workspace.getConfiguration('angularComponentPreview');
        const autoMock = config.get<boolean>('autoMockServices', true);
        const rawPort = config.get<number>('port', 0);
        const preferredPort =
          typeof rawPort === 'number' && Number.isInteger(rawPort) && (rawPort === 0 || (rawPort >= 1024 && rawPort <= 65535))
            ? rawPort
            : 0;
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(componentFilePath))?.uri.fsPath;

        if (!previewServer) {
          previewServer = new PreviewServer();
        }

        const sandbox = sandboxGenerator.generateSandbox(
          meta,
          autoMock,
          previewServer.getSessionToken(),
          workspaceRoot
        );

        await previewServer.startOrUpdate(
          sandbox,
          preferredPort,
          (buildError) => {
            PreviewPanel.currentPanel?.showBuildStatus(buildError);
          },
          { allowWorkspaceModules: vscode.workspace.isTrusted !== false }
        );

        PreviewPanel.createOrShow(
          previewServer.getPreviewBaseUrl(),
          meta,
          () => {
            // Stop server when preview tab is closed to free resources
            previewServer?.stop();
            currentMetadata = null;
          },
          async () => {
            if (currentMetadata && previewServer) {
              const refreshedMeta = analyzer.analyzeFile(currentMetadata.filePath) || currentMetadata;
              const refreshedSandbox = sandboxGenerator.generateSandbox(
                refreshedMeta,
                autoMock,
                previewServer.getSessionToken(),
                workspaceRoot
              );
              previewServer.updateSandbox(refreshedSandbox);
              await previewServer.triggerRebuild();
            }
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Angular Component Preview failed: ${err?.message || String(err)}`
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
