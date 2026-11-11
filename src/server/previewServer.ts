import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type * as esbuildType from 'esbuild';
import { SandboxGenerationResult } from '../sandbox/sandboxGenerator';
import { assertNoLinksBelow, escapeHtml, isPathInside } from '../security/guards';

export interface PreviewServerOptions {
  /**
   * Allows loading the `sass` compiler from the opened project's `node_modules`.
   * Must only be true for trusted workspaces, since it executes workspace code in the extension host.
   */
  allowWorkspaceModules?: boolean;
}

const TEMPLATE_EXTENSIONS = new Set(['.html', '.htm']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass']);
const MAX_SSE_CLIENTS = 16;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

const BASE_HEADERS: http.OutgoingHttpHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

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
  private allowWorkspaceModules = false;
  /**
   * Random per-session secret. Every privileged route lives under `/<token>/`, so other local
   * processes or web pages (e.g. via DNS rebinding) cannot read the compiled bundle or the SSE stream.
   */
  private readonly sessionToken = crypto.randomBytes(24).toString('hex');

  /** Base URL (with trailing slash) that the webview iframe must load. */
  public getPreviewBaseUrl(): string {
    return `http://127.0.0.1:${this.currentPort}/${this.sessionToken}/`;
  }

  public getSessionToken(): string {
    return this.sessionToken;
  }

  /**
   * Always uses the esbuild bundled with the extension. Loading `esbuild` from the opened
   * project's `node_modules` would let a malicious repository execute code in the extension host.
   */
  private resolveEsbuild(): typeof esbuildType {
    return require('esbuild');
  }

  public async startOrUpdate(
    sandbox: SandboxGenerationResult,
    preferredPort = 0,
    onBuildComplete?: (error?: string) => void,
    options: PreviewServerOptions = {}
  ): Promise<number> {
    this.currentSandbox = sandbox;
    this.allowWorkspaceModules = options.allowWorkspaceModules === true;
    const esbuild = this.resolveEsbuild();

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
    // Never let esbuild write through a symlink/junction planted by the repository
    assertNoLinksBelow(path.join(sandbox.projectRoot, 'node_modules'), outDir);
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
      sourcesContent: false,
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

    // Perform an explicit initial build BEFORE returning so `main.preview.js` is guaranteed
    // to be updated on disk for the new component before the Webview iframe loads it.
    try {
      await this.buildContext.rebuild();
    } catch {
      // Build errors are already reported via the plugin's onEnd hook
    }

    if (!this.server) {
      this.currentPort = await this.listenHttp(preferredPort);
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
        this.broadcastSse('reload');
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
        const fullPath = this.resolveProjectResource(fileDir, relPath, projectRoot, TEMPLATE_EXTENSIONS);
        if (fullPath) {
          const html = await fs.promises.readFile(fullPath, 'utf-8');
          const escaped = html
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
          return `template: \`${escaped}\``;
        }
        return `template: ${JSON.stringify(
          `<div style="color:red">Missing or blocked template: ${escapeHtml(relPath)}</div>`
        )}`;
      }
    );

    // 2. Inline styleUrl: './...' (Angular v17+ singular styleUrl)
    const styleUrlRegex = /styleUrl\s*:\s*['"`]([^'"`]+)['"`]/g;
    transformed = await this.replaceAsync(
      transformed,
      styleUrlRegex,
      async (_match, relPath) => {
        const fullPath = this.resolveProjectResource(fileDir, relPath, projectRoot, STYLE_EXTENSIONS);
        const css = fullPath ? await this.loadAndCompileStyleFile(fullPath, projectRoot) : '';
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
          const fullPath = this.resolveProjectResource(fileDir, p, projectRoot, STYLE_EXTENSIONS);
          const css = fullPath ? await this.loadAndCompileStyleFile(fullPath, projectRoot) : '';
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

  /**
   * Resolves a component resource (`templateUrl`, `styleUrl(s)`) and only returns it when it is an
   * existing regular file with an allowed extension that lives inside the project root.
   * Prevents a component from inlining arbitrary files from the user's disk into the served bundle.
   */
  private resolveProjectResource(
    fileDir: string,
    relPath: string,
    projectRoot: string,
    allowedExtensions: Set<string>
  ): string | null {
    const fullPath = path.resolve(fileDir, relPath);
    if (!allowedExtensions.has(path.extname(fullPath).toLowerCase())) {
      return null;
    }
    if (!isPathInside(projectRoot, fullPath)) {
      return null;
    }
    try {
      return fs.statSync(fullPath).isFile() ? fullPath : null;
    } catch {
      return null;
    }
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
   * Attempts to use the user project's installed `sass` package if available (trusted workspaces only);
   * otherwise performs a lightweight SCSS strip so styles still apply cleanly.
   */
  private async compileScssIfAvailable(
    scssPath: string,
    projectRoot: string
  ): Promise<string> {
    try {
      if (!this.allowWorkspaceModules) {
        throw new Error('Workspace modules are disabled for untrusted workspaces');
      }
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

  /** Only accept requests addressed to the loopback host:port we bound (blocks DNS rebinding). */
  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) {
      return false;
    }
    const host = hostHeader.toLowerCase();
    return host === `127.0.0.1:${this.currentPort}` || host === `localhost:${this.currentPort}`;
  }

  private sendText(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  private sendFile(res: http.ServerResponse, filePath: string, isHead: boolean): void {
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': contentType });
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /**
   * Maps a public URL path to a static asset, Angular CLI style:
   * `/assets/**` -> `src/assets/**`, `/favicon.ico` -> `src/favicon.ico`, everything else -> `public/**`.
   * The resolved file must stay inside its base directory (no `..`, no symlink escape, no dotfiles).
   */
  private resolveStaticAsset(projectRoot: string, urlPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) {
      return null;
    }
    const segments = decoded.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === '..' || s.startsWith('.') || s.includes(':'))) {
      return null;
    }

    const candidates: Array<{ base: string; rel: string[] }> = [];
    if (segments[0] === 'assets') {
      candidates.push({ base: path.join(projectRoot, 'src', 'assets'), rel: segments.slice(1) });
    }
    if (segments.length === 1 && segments[0] === 'favicon.ico') {
      candidates.push({ base: path.join(projectRoot, 'src'), rel: segments });
    }
    candidates.push({ base: path.join(projectRoot, 'public'), rel: segments });

    for (const { base, rel } of candidates) {
      if (rel.length === 0) {
        continue;
      }
      const candidate = path.join(base, ...rel);
      if (!isPathInside(base, candidate)) {
        continue;
      }
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // not found, try next base
      }
    }
    return null;
  }

  private listenHttp(preferredPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (!this.isAllowedHost(req.headers.host)) {
          this.sendText(res, 403, 'Forbidden host');
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          this.sendText(res, 405, 'Method not allowed');
          return;
        }
        const isHead = req.method === 'HEAD';

        if (!this.currentSandbox) {
          this.sendText(res, 503, 'Sandbox not initialized');
          return;
        }

        const rawPath = (req.url || '/').split('?')[0];
        const tokenPrefix = `/${this.sessionToken}`;
        const hasToken =
          rawPath === tokenPrefix || rawPath.startsWith(`${tokenPrefix}/`);
        // Path relative to the session root (always starts with '/')
        const urlPath = hasToken
          ? rawPath.slice(tokenPrefix.length) || '/'
          : rawPath;

        const outDir = path.join(this.currentSandbox.sandboxDir, 'dist');

        // Privileged routes: only reachable through the secret session prefix
        if (hasToken) {
          // SSE endpoint for Live Reload (same-origin only, no CORS headers)
          if (urlPath === '/__ng_live_sse') {
            if (this.sseClients.size >= MAX_SSE_CLIENTS) {
              this.sendText(res, 429, 'Too many live-reload clients');
              return;
            }
            res.writeHead(200, {
              ...BASE_HEADERS,
              'Content-Type': 'text/event-stream',
              Connection: 'keep-alive',
            });
            res.write('data: connected\n\n');
            this.sseClients.add(res);
            req.on('close', () => this.sseClients.delete(res));
            return;
          }

          if (urlPath === '/' || urlPath === '/index.html') {
            const html = fs.readFileSync(this.currentSandbox.indexHtmlPath, 'utf-8');
            res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
            res.end(isHead ? undefined : html);
            return;
          }

          if (urlPath === '/main.preview.js') {
            const jsPath = path.join(outDir, 'main.preview.js');
            if (fs.existsSync(jsPath)) {
              this.sendFile(res, jsPath, isHead);
            } else {
              this.sendText(res, 404, '// Bundle building...');
            }
            return;
          }

          if (urlPath === '/bundle.css' || urlPath === '/main.preview.css') {
            const cssPath = path.join(outDir, 'main.preview.css');
            if (fs.existsSync(cssPath)) {
              this.sendFile(res, cssPath, isHead);
            } else {
              res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/css; charset=utf-8' });
              res.end('/* no global css bundle */');
            }
            return;
          }
        }

        // Fallback: serve static assets (`src/assets`, `src/favicon.ico`, `public/`), confined to those folders
        const asset = this.resolveStaticAsset(this.currentSandbox.projectRoot, urlPath);
        if (asset) {
          this.sendFile(res, asset, isHead);
          return;
        }

        this.sendText(res, 404, 'Not found');
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
