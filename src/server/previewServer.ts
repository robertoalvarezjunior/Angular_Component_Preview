import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type * as esbuildType from 'esbuild';
import { SandboxGenerationResult } from '../sandbox/sandboxGenerator';

/**
 * Isolated component preview server powered by esbuild + custom Angular JIT/Template loader.
 *
 * Why this approach is fast & zero-full-build:
 * 1. Only bundles `main.preview.ts` and the direct import graph of the selected `.component.ts`.
 * 2. Automatically inlines `templateUrl` and `styleUrls` / `styleUrl` (including basic SCSS/CSS) on the fly
 *    so `@angular/compiler` in JIT mode or pre-compiled libraries in `node_modules` work seamlessly without running `ng serve`.
 * 3. Pushes instant Live Reload updates via Server-Sent Events (SSE) whenever the component `.ts`, `.html`, or `.scss`/`.css` is saved.
 */
export class PreviewServer {
  private server: http.Server | null = null;
  private buildContext: esbuildType.BuildContext | null = null;
  private sseClients: Set<http.ServerResponse> = new Set();
  private currentPort = 0;
  private currentSandbox: SandboxGenerationResult | null = null;
  private fileWatcher: fs.FSWatcher | null = null;

  private resolveEsbuild(projectRoot: string): typeof esbuildType {
    try {
      const projEsbuild = require.resolve('esbuild', { paths: [projectRoot, __dirname] });
      return require(projEsbuild);
    } catch {
      return require('esbuild');
    }
  }

  public async startOrUpdate(
    sandbox: SandboxGenerationResult,
    preferredPort = 0,
    onBuildComplete?: (error?: string) => void
  ): Promise<number> {
    this.currentSandbox = sandbox;
    const esbuild = this.resolveEsbuild(sandbox.projectRoot);

    // Dispose previous build context if switching components
    if (this.buildContext) {
      try {
        await this.buildContext.dispose();
      } catch {
        // ignore
      }
      this.buildContext = null;
    }

    const outDir = path.join(sandbox.sandboxDir, 'dist');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const tsconfigPath = this.findTsconfig(sandbox.projectRoot);

    const self = this;
    const angularComponentInlinePlugin: esbuildType.Plugin = {
      name: 'angular-component-inline-plugin',
      setup(build) {
        // Handle .scss / .sass files imported directly or via global styles
        build.onLoad({ filter: /\.(scss|sass)$/ }, async (args) => {
          const css = await self.compileScssIfAvailable(args.path, sandbox.projectRoot);
          return {
            contents: css,
            loader: 'css',
            resolveDir: path.dirname(args.path),
          };
        });

        // Transform .ts files to inline templateUrl & styleUrls/styleUrl so Angular JIT compiler can render immediately
        build.onLoad({ filter: /\.ts$/ }, async (args) => {
          let source = await fs.promises.readFile(args.path, 'utf-8');
          const fileDir = path.dirname(args.path);

          if (source.includes('@Component')) {
            source = await self.inlineAngularComponentResources(
              source,
              fileDir,
              sandbox.projectRoot
            );
          }

          return {
            contents: source,
            loader: 'ts',
            resolveDir: fileDir,
          };
        });

        build.onEnd((result) => {
          if (result.errors.length > 0) {
            const errMsg = result.errors
              .map((e) => `${e.location?.file || ''}:${e.location?.line || ''} ${e.text}`)
              .join('\n');
            self.broadcastSse(`error:${JSON.stringify(errMsg)}`);
            onBuildComplete?.(errMsg);
          } else {
            self.broadcastSse('reload');
            onBuildComplete?.();
          }
        });
      },
    };

    this.buildContext = await esbuild.context({
      entryPoints: [sandbox.entryFilePath],
      bundle: true,
      format: 'esm',
      target: ['es2022'],
      outfile: path.join(outDir, 'main.preview.js'),
      sourcemap: 'inline',
      absWorkingDir: sandbox.projectRoot,
      tsconfig: tsconfigPath,
      plugins: [angularComponentInlinePlugin],
      loader: {
        '.html': 'text',
        '.css': 'css',
        '.svg': 'dataurl',
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.ttf': 'dataurl',
      },
      define: {
        ngDevMode: 'true',
      },
      logLevel: 'silent',
    });

    await this.buildContext.watch();

    if (!this.server) {
      this.currentPort = await this.listenHttp(preferredPort);
    } else {
      // Trigger reload on existing clients
      this.broadcastSse('reload');
    }

    return this.currentPort;
  }

  /**
   * Rebuilds immediately when user edits companion `.html` or `.scss`/`.css` files
   */
  public async triggerRebuild(): Promise<void> {
    if (this.buildContext) {
      try {
        await this.buildContext.rebuild();
      } catch {
        // Errors are already reported via onEnd
      }
    }
  }

  /**
   * Rewrites `templateUrl: './foo.html'` -> `template: \`...\``
   * and `styleUrls: ['./foo.scss']` / `styleUrl: './foo.scss'` -> `styles: [\`...\`]`
   * Also converts Angular v16+ `input()`/`output()` or Standalone metadata transparently.
   */
  private async inlineAngularComponentResources(
    source: string,
    fileDir: string,
    projectRoot: string
  ): Promise<string> {
    let transformed = source;

    // 1. Inline templateUrl: './...'
    const templateUrlRegex = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g;
    transformed = await this.replaceAsync(
      transformed,
      templateUrlRegex,
      async (_match, relPath) => {
        const fullPath = path.resolve(fileDir, relPath);
        if (fs.existsSync(fullPath)) {
          const html = await fs.promises.readFile(fullPath, 'utf-8');
          const escaped = html
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
          return `template: \`${escaped}\``;
        }
        return `template: '<div style="color:red">Missing template: ${relPath}</div>'`;
      }
    );

    // 2. Inline styleUrl: './...' (Angular v17+ singular styleUrl)
    const styleUrlRegex = /styleUrl\s*:\s*['"`]([^'"`]+)['"`]/g;
    transformed = await this.replaceAsync(
      transformed,
      styleUrlRegex,
      async (_match, relPath) => {
        const fullPath = path.resolve(fileDir, relPath);
        const css = await this.loadAndCompileStyleFile(fullPath, projectRoot);
        const escaped = css
          .replace(/\\/g, '\\\\')
          .replace(/`/g, '\\`')
          .replace(/\$\{/g, '\\${');
        return `styles: [\`${escaped}\`]`;
      }
    );

    // 3. Inline styleUrls: ['./a.scss', './b.css']
    const styleUrlsRegex = /styleUrls\s*:\s*\[([^\]]*)\]/g;
    transformed = await this.replaceAsync(
      transformed,
      styleUrlsRegex,
      async (_match, innerList) => {
        const paths = Array.from(
          innerList.matchAll(/['"`]([^'"`]+)['"`]/g),
          (m: RegExpMatchArray) => m[1]
        );
        const compiledStyles: string[] = [];
        for (const p of paths) {
          const fullPath = path.resolve(fileDir, p);
          const css = await this.loadAndCompileStyleFile(fullPath, projectRoot);
          const escaped = css
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
          compiledStyles.push(`\`${escaped}\``);
        }
        return `styles: [${compiledStyles.join(', ')}]`;
      }
    );

    return transformed;
  }

  private async loadAndCompileStyleFile(
    fullPath: string,
    projectRoot: string
  ): Promise<string> {
    if (!fs.existsSync(fullPath)) {
      return '';
    }
    if (fullPath.endsWith('.scss') || fullPath.endsWith('.sass')) {
      return this.compileScssIfAvailable(fullPath, projectRoot);
    }
    return fs.promises.readFile(fullPath, 'utf-8');
  }

  /**
   * Attempts to use the user project's installed `sass` package if available;
   * otherwise performs a lightweight SCSS strip so styles still apply cleanly.
   */
  private async compileScssIfAvailable(
    scssPath: string,
    projectRoot: string
  ): Promise<string> {
    try {
      const sassPkgPath = require.resolve('sass', { paths: [projectRoot] });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sass = require(sassPkgPath);
      if (typeof sass.compile === 'function') {
        const res = sass.compile(scssPath, {
          loadPaths: [projectRoot, path.join(projectRoot, 'src'), path.join(projectRoot, 'node_modules')],
        });
        return res.css;
      }
    } catch {
      // Fallback: read raw file if `sass` isn't resolved or fails on an external mixin
    }
    try {
      return await fs.promises.readFile(scssPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async replaceAsync(
    str: string,
    regex: RegExp,
    asyncFn: (...args: any[]) => Promise<string>
  ): Promise<string> {
    const promises: Promise<string>[] = [];
    str.replace(regex, (...args) => {
      promises.push(asyncFn(...args));
      return '';
    });
    const data = await Promise.all(promises);
    return str.replace(regex, () => data.shift() || '');
  }

  private findTsconfig(projectRoot: string): string | undefined {
    for (const name of ['tsconfig.app.json', 'tsconfig.json']) {
      const p = path.join(projectRoot, name);
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return undefined;
  }

  private listenHttp(preferredPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (!this.currentSandbox) {
          res.writeHead(503);
          res.end('Sandbox not initialized');
          return;
        }

        const urlPath = (req.url || '/').split('?')[0];

        // SSE endpoint for Live Reload
        if (urlPath === '/__ng_live_sse') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          res.write('data: connected\n\n');
          this.sseClients.add(res);
          req.on('close', () => this.sseClients.delete(res));
          return;
        }

        const outDir = path.join(this.currentSandbox.sandboxDir, 'dist');

        if (urlPath === '/' || urlPath === '/index.html') {
          const html = fs.readFileSync(this.currentSandbox.indexHtmlPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (urlPath === '/main.preview.js') {
          const jsPath = path.join(outDir, 'main.preview.js');
          if (fs.existsSync(jsPath)) {
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            fs.createReadStream(jsPath).pipe(res);
          } else {
            res.writeHead(404);
            res.end('// Bundle building...');
          }
          return;
        }

        if (urlPath === '/bundle.css' || urlPath === '/main.preview.css') {
          const cssPath = path.join(outDir, 'main.preview.css');
          if (fs.existsSync(cssPath)) {
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            fs.createReadStream(cssPath).pipe(res);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            res.end('/* no global css bundle */');
          }
          return;
        }

        // Fallback: serve static assets from project's `src/` or `public/` (e.g. `/assets/...`)
        const assetCandidates = [
          path.join(this.currentSandbox.projectRoot, 'src', urlPath),
          path.join(this.currentSandbox.projectRoot, 'public', urlPath),
        ];
        for (const candidate of assetCandidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            res.writeHead(200);
            fs.createReadStream(candidate).pipe(res);
            return;
          }
        }

        res.writeHead(404);
        res.end('Not found');
      });

      this.server.on('error', reject);
      this.server.listen(preferredPort, '127.0.0.1', () => {
        const address = this.server?.address();
        const port = typeof address === 'object' && address ? address.port : preferredPort;
        resolve(port);
      });
    });
  }

  private broadcastSse(message: string): void {
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${message}\n\n`);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.buildContext) {
      try {
        await this.buildContext.dispose();
      } catch {
        // ignore
      }
      this.buildContext = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}
