import * as fs from 'fs';
import * as path from 'path';
import { ComponentMetadata } from '../analyzer/componentAnalyzer';
import {
  assertNoLinksBelow,
  escapeHtml,
  isPathInside,
  isSafeElementSelector,
  isSafeIdentifier,
  safeWriteFile,
} from '../security/guards';

export interface SandboxGenerationResult {
  sandboxDir: string;
  projectRoot: string;
  entryFilePath: string;
  indexHtmlPath: string;
  globalStyles: string[];
  sessionToken: string;
}

export class SandboxGenerator {
  /**
   * Generates the isolated preview files inside `<projectRoot>/node_modules/.cache/angular-component-preview`
   * so that Node module resolution, tsconfig paths, and Angular compiler work natively without polluting git.
   */
  public generateSandbox(
    meta: ComponentMetadata,
    autoMockServices: boolean,
    sessionToken: string
  ): SandboxGenerationResult {
    if (!isSafeElementSelector(meta.selector)) {
      throw new Error(
        `Unsupported component selector "${meta.selector}". Only element selectors (e.g. "app-user-card") can be previewed.`
      );
    }
    if (!isSafeIdentifier(meta.className)) {
      throw new Error(`Unsupported component class name "${meta.className}".`);
    }

    const projectRoot = this.findAngularProjectRoot(meta.filePath);
    const sandboxDir = path.join(
      projectRoot,
      'node_modules',
      '.cache',
      'angular-component-preview'
    );

    // Refuse to follow symlinks/junctions planted by the repository (would redirect writes outside the project)
    assertNoLinksBelow(path.join(projectRoot, 'node_modules'), sandboxDir);
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }

    const globalStyles = this.findGlobalStyles(projectRoot);

    // 1. Write the Universal DI Auto-Mock utility
    const autoMockFilePath = path.join(sandboxDir, 'auto-mock.ts');
    safeWriteFile(autoMockFilePath, this.buildAutoMockSource());

    // 2. Write the isolated PreviewHostComponent + bootstrapper (`main.preview.ts`)
    const entryFilePath = path.join(sandboxDir, 'main.preview.ts');
    const mainSource = this.buildMainPreviewSource(
      meta,
      sandboxDir,
      projectRoot,
      globalStyles,
      autoMockServices
    );
    safeWriteFile(entryFilePath, mainSource);

    // 3. Write index.html
    const indexHtmlPath = path.join(sandboxDir, 'index.html');
    safeWriteFile(indexHtmlPath, this.buildIndexHtml(meta, sessionToken));

    return {
      sandboxDir,
      projectRoot,
      entryFilePath,
      indexHtmlPath,
      globalStyles,
      sessionToken,
    };
  }

  private findAngularProjectRoot(componentFilePath: string): string {
    let dir = path.dirname(componentFilePath);
    while (true) {
      if (
        fs.existsSync(path.join(dir, 'angular.json')) ||
        fs.existsSync(path.join(dir, 'package.json'))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return path.dirname(componentFilePath);
      }
      dir = parent;
    }
  }

  /**
   * Reads `angular.json` to discover global style files (`src/styles.scss`, `src/styles.css`, etc.)
   */
  private findGlobalStyles(projectRoot: string): string[] {
    const angularJsonPath = path.join(projectRoot, 'angular.json');
    const styles: string[] = [];

    if (fs.existsSync(angularJsonPath)) {
      try {
        const angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf-8'));
        const projects = angularJson.projects || {};
        for (const projName of Object.keys(projects)) {
          const buildOpts =
            projects[projName]?.architect?.build?.options ||
            projects[projName]?.targets?.build?.options;
          if (buildOpts && Array.isArray(buildOpts.styles)) {
            for (const s of buildOpts.styles) {
              const styleRel = typeof s === 'string' ? s : s?.input;
              if (styleRel) {
                const absStyle = path.resolve(projectRoot, styleRel);
                // Only bundle style files that live inside the project
                if (
                  /\.(css|scss|sass)$/i.test(absStyle) &&
                  fs.existsSync(absStyle) &&
                  isPathInside(projectRoot, absStyle)
                ) {
                  styles.push(absStyle);
                }
              }
            }
            break;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Fallback check for common global styles
    if (styles.length === 0) {
      for (const candidate of ['src/styles.scss', 'src/styles.css', 'src/styles.sass']) {
        const abs = path.join(projectRoot, candidate);
        if (fs.existsSync(abs)) {
          styles.push(abs);
          break;
        }
      }
    }

    return styles;
  }

  /**
   * Generates `auto-mock.ts`, which provides:
   * 1. Smart DI Provider Factory (`createSmartServiceProvider`): Uses Angular's real injector (`inject(Token)`)
   *    to instantiate the real service (preserving real Signals, `computed()`, RxJS streams, and HttpClient calls),
   *    and wraps it in a fault-tolerant Proxy fallback that only steps in if a missing method/property is accessed
   *    or if instantiation throws.
   * 2. Universal Recursive Proxy Mock (`createUniversalServiceMock`) where every property is ALWAYS a callable function
   *    (so Angular Signals like `service.count()` or `service.favorites()` never throw `is not a function`),
   *    while also implementing `Symbol.toPrimitive`, Array methods, RxJS Observable (`.pipe`, `.subscribe`), and `Set` methods (`.has`).
   */
  private buildAutoMockSource(): string {
    return `// Auto-generated by Angular Component Preview Extension
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';

const SAMPLE_CARD_ITEM: Record<string, any> = {
  id: 25,
  formattedId: '#025',
  name: 'Pikachu',
  title: 'Sample Title',
  label: 'Sample Label',
  description: 'Sample description text for isolated preview.',
  imageUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png',
  image: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png',
  sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png',
  avatar: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png',
  types: ['electric'],
  type: 'electric',
  heightInMeters: 0.4,
  weightInKg: 6.0,
  height: 4,
  weight: 60,
  baseExperience: 112,
  stats: [
    { key: 'hp', label: 'HP (Vida)', value: 35, percentage: 25 },
    { key: 'attack', label: 'Ataque', value: 55, percentage: 40 },
    { key: 'speed', label: 'Velocidade', value: 90, percentage: 60 },
  ],
  abilities: [{ name: 'static', isHidden: false }],
};

export function createSampleArrayInput(inputName: string): any[] {
  const lower = inputName.toLowerCase();
  if (lower.includes('type') || lower.includes('option')) {
    return [
      { value: 'all', label: 'Todos os tipos' },
      { value: 'electric', label: 'Elétrico' },
      { value: 'fire', label: 'Fogo' },
      { value: 'water', label: 'Água' },
      { value: 'grass', label: 'Planta' },
    ];
  }
  return [{ ...SAMPLE_CARD_ITEM }];
}

export function createSampleObjectInput(_inputName: string): any {
  return { ...SAMPLE_CARD_ITEM };
}

const PRIMITIVE_HINTS: Record<string, any> = {
  ...SAMPLE_CARD_ITEM,
  count: 1,
  total: 12,
  page: 1,
  currentPage: 1,
  totalPages: 3,
  pageSize: 12,
};

/**
 * Attempts to instantiate a real Angular service inside the current Injector context
 * (so real Signals, computed(), HttpClient, and business logic work out-of-the-box!),
 * and wraps it with a resilient Proxy that falls back to createUniversalServiceMock
 * if any method throws or is undefined.
 */
export function createSmartServiceInstance(Token: any, tokenName: string, injector: Injector): any {
  try {
    const realInstance = runInInjectionContext(injector, () => new Token());
    return wrapRealServiceWithFallback(realInstance, tokenName);
  } catch (err) {
    console.warn(\`[Angular Component Preview] Could not instantiate real \${tokenName}, using universal auto-mock:\`, err);
    return createUniversalServiceMock(tokenName);
  }
}

function wrapRealServiceWithFallback(realInstance: any, serviceName: string): any {
  const fallbackMock = createUniversalServiceMock(serviceName);
  return new Proxy(realInstance, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          // Preserve Angular Signal metadata (e.g. [SIGNAL] symbol) if it's a signal/computed function!
          if (Object.getOwnPropertySymbols(value).length > 0) {
            return value;
          }
          const wrappedFn = function (this: any, ...args: any[]) {
            try {
              return value.apply(this === receiver ? target : this, args);
            } catch (err) {
              console.warn(\`[Angular Component Preview] Fallback on \${serviceName}.\${String(prop)}():\`, err);
              return fallbackMock[prop](...args);
            }
          };
          Object.assign(wrappedFn, value);
          return wrappedFn;
        }
        return value;
      }
      return fallbackMock[prop];
    },
  });
}

/**
 * Creates a universal recursive Proxy mock for any Angular Service, Signal, or @Input data model.
 * CRITICAL RULE: Every property returned by this Proxy is ALSO a callable function so that
 * calling service.count(), service.favorites(), or service.getData() NEVER throws "is not a function".
 */
export function createUniversalServiceMock(serviceName: string, depth = 0, propKey = ''): any {
  if (depth > 6) {
    const leafFn: any = () => '';
    leafFn[Symbol.toPrimitive] = () => '';
    return leafFn;
  }

  const cache = new Map<string | symbol, any>();
  const sampleValue = propKey in PRIMITIVE_HINTS ? PRIMITIVE_HINTS[propKey] : undefined;

  const callableTarget = function (..._args: any[]) {
    // If called as a Signal or getter (e.g. favoritesService.count() or favoritesService.favorites())
    if (typeof sampleValue === 'number' || typeof sampleValue === 'boolean' || typeof sampleValue === 'string') {
      return sampleValue;
    }
    return createHybridReturnProxy(\`\${serviceName}()\`, depth + 1, propKey);
  };

  return new Proxy(callableTarget, {
    get(_target, prop) {
      if (prop === '__isAutoMock') return true;
      if (prop === 'then') return undefined;

      // Primitive coercion when used directly in template interpolation {{ pokemon.name }}
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => {
          if (sampleValue !== undefined && typeof sampleValue !== 'object') {
            return sampleValue;
          }
          return hint === 'number' ? 1 : 'Sample';
        };
      }
      if (prop === 'toString') {
        return () => (sampleValue !== undefined && typeof sampleValue !== 'object' ? String(sampleValue) : 'Sample');
      }
      if (prop === 'valueOf') {
        return () => (sampleValue !== undefined ? sampleValue : 'Sample');
      }

      // Direct primitive / array values for known model properties (like pokemon.types, pokemon.name, pokemon.id)
      if (typeof prop === 'string' && prop in SAMPLE_CARD_ITEM) {
        const val = SAMPLE_CARD_ITEM[prop];
        // Only return raw primitive/array if it's NOT typically called as a Signal/method on a service
        if (!['count', 'total', 'page', 'favorites'].includes(prop)) {
          return val;
        }
      }

      // Set compatibility (e.g. favoriteIds().has(id))
      if (prop === 'has') return () => false;
      if (prop === 'set' || prop === 'update' || prop === 'asReadonly') {
        return () => createUniversalServiceMock(serviceName, depth + 1, propKey);
      }

      // Array / Iterable compatibility when template iterates over a property (@for / *ngFor)
      if (prop === Symbol.iterator) {
        const item = createUniversalServiceMock(\`\${serviceName}[0]\`, depth + 1);
        return function* () {
          yield item;
        };
      }
      if (prop === 'length') return 1;
      if (prop === 'map') {
        const item = createUniversalServiceMock(\`\${serviceName}[0]\`, depth + 1);
        return (fn: any) => [fn(item, 0)];
      }
      if (prop === 'filter' || prop === 'slice') {
        const item = createUniversalServiceMock(\`\${serviceName}[0]\`, depth + 1);
        return () => [item];
      }
      if (prop === 'forEach') {
        const item = createUniversalServiceMock(\`\${serviceName}[0]\`, depth + 1);
        return (fn: any) => fn(item, 0);
      }
      if (prop === 'some' || prop === 'every' || prop === 'includes') {
        return () => false;
      }

      // RxJS Observable compatibility (.subscribe(), .pipe())
      if (prop === 'subscribe') {
        return (observerOrNext?: any) => {
          const sub = { unsubscribe: () => {}, closed: false };
          const mockList = [createUniversalServiceMock(\`\${serviceNameItem(serviceName)}\`, depth + 1)];
          try {
            if (typeof observerOrNext === 'function') {
              observerOrNext(mockList);
            } else if (observerOrNext && typeof observerOrNext.next === 'function') {
              observerOrNext.next(mockList);
            }
          } catch (e) {
            console.warn('[Angular Component Preview] Warning in mock subscribe:', e);
          }
          return sub;
        };
      }
      if (prop === 'pipe') {
        return (..._operators: any[]) => of([createUniversalServiceMock(\`\${serviceName}[0]\`, depth + 1)]);
      }

      if (!cache.has(prop)) {
        cache.set(
          prop,
          createUniversalServiceMock(\`\${serviceName}.\${String(prop)}\`, depth + 1, String(prop))
        );
      }
      return cache.get(prop);
    },
    set(_target, prop, value) {
      cache.set(prop, value);
      return true;
    },
  });
}

function serviceNameItem(name: string): string {
  return \`\${name}[0]\`;
}

function createHybridReturnProxy(label: string, depth: number, propKey: string): any {
  const sampleItem = createUniversalServiceMock(\`\${label}[0]\`, depth + 1);
  const obs$ = of([sampleItem]);

  return new Proxy(obs$, {
    get(target: any, prop) {
      // Array & length compatibility (e.g. favoritesService.favorites().length === 0 or @for (p of favoritesService.favorites()))
      if (prop === 'length') return 1;
      if (prop === Symbol.iterator) {
        return function* () {
          yield sampleItem;
        };
      }
      if (prop === 'map') return (fn: any) => [fn(sampleItem, 0)];
      if (prop === 'filter' || prop === 'slice') return () => [sampleItem];
      if (prop === 'forEach') return (fn: any) => fn(sampleItem, 0);
      if (prop === 'some' || prop === 'includes') return () => false;

      // Set compatibility (e.g. favoritesService.favoriteIds().has(id))
      if (prop === 'has') return () => false;

      // Native Observable methods (.pipe, .subscribe)
      if (prop in target) {
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
      // Promise compatibility (.then, .catch, .finally)
      if (prop === 'then') {
        return (resolve?: any) => Promise.resolve([sampleItem]).then(resolve);
      }
      if (prop === 'catch') {
        return () => Promise.resolve([sampleItem]);
      }
      if (prop === 'finally') {
        return (cb?: any) => Promise.resolve([sampleItem]).finally(cb);
      }
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === 'number' ? (propKey === 'count' ? 1 : 0) : 'Sample');
      }
      return createUniversalServiceMock(\`\${label}.\${String(prop)}\`, depth + 1, String(prop));
    },
  });
}

export function createActivatedRouteMock() {
  return {
    snapshot: {
      params: { id: '25' },
      queryParams: {},
      data: {},
      url: [],
      fragment: null,
      paramMap: {
        get: (_key: string) => '25',
        has: (_key: string) => true,
        getAll: (_key: string) => ['25'],
        keys: ['id'],
      },
      queryParamMap: {
        get: (_key: string) => null,
        has: (_key: string) => false,
        getAll: (_key: string) => [],
        keys: [],
      },
    },
    params: of({ id: '25' }),
    queryParams: of({}),
    data: of({}),
    url: of([]),
    fragment: of(null),
    paramMap: of({
      get: (_key: string) => '25',
      has: (_key: string) => true,
      getAll: (_key: string) => ['25'],
      keys: ['id'],
    }),
    queryParamMap: of({
      get: (_key: string) => null,
      has: (_key: string) => false,
      getAll: (_key: string) => [],
      keys: [],
    }),
  };
}
`;
  }

  private toPosixRelativeImport(fromDir: string, targetFilePath: string): string {
    let rel = path.relative(fromDir, targetFilePath).replace(/\\/g, '/');
    rel = rel.replace(/\.tsx?$/, '');
    if (!rel.startsWith('.')) {
      rel = './' + rel;
    }
    return rel;
  }

  private buildMainPreviewSource(
    meta: ComponentMetadata,
    sandboxDir: string,
    projectRoot: string,
    globalStyles: string[],
    autoMockServices: boolean
  ): string {
    const componentImportPath = this.toPosixRelativeImport(sandboxDir, meta.filePath);

    // Import global styles (specifiers are JSON-encoded so paths can never break out of the string literal)
    const styleImports = globalStyles
      .map((s) => `import ${JSON.stringify(s.replace(/\\/g, '/'))};`)
      .join('\n');

    // Resolve injected dependencies to mock providers
    const depImports: string[] = [];
    const depProviders: string[] = [];
    const componentDir = path.dirname(meta.filePath);

    if (autoMockServices) {
      meta.dependencies.forEach((dep, index) => {
        if (dep.tokenName === 'ActivatedRoute' || dep.tokenName === 'Router') {
          // Handled by router mock providers below
          return;
        }
        // Tokens like @Inject('API_URL') or expressions cannot be imported by name; skip them safely
        if (!isSafeIdentifier(dep.tokenName)) {
          return;
        }
        if (dep.importPath) {
          let resolvedSpecifier = dep.importPath;
          if (dep.importPath.startsWith('.')) {
            const absDepPath = path.resolve(componentDir, dep.importPath);
            resolvedSpecifier = this.toPosixRelativeImport(sandboxDir, absDepPath);
          }
          const specifierLiteral = JSON.stringify(resolvedSpecifier);
          const aliasName = `DepToken_${index}_${dep.tokenName}`;
          if (dep.isDefaultImport) {
            depImports.push(`import ${aliasName} from ${specifierLiteral};`);
          } else {
            depImports.push(`import { ${dep.tokenName} as ${aliasName} } from ${specifierLiteral};`);
          }
          depProviders.push(
            `    { provide: ${aliasName}, useFactory: (injector: Injector) => createSmartServiceInstance(${aliasName}, '${dep.tokenName}', injector), deps: [Injector] },`
          );
        }
      });
    }

    // Optional declaring NgModule import if standalone === false
    let declaringModuleImport = '';
    let hostImportsList = meta.standalone ? `[${meta.className}]` : `[]`;

    if (!meta.standalone && meta.declaringModule && isSafeIdentifier(meta.declaringModule.className)) {
      const modSpecifier = this.toPosixRelativeImport(sandboxDir, meta.declaringModule.filePath);
      declaringModuleImport = `import { ${meta.declaringModule.className} } from ${JSON.stringify(modSpecifier)};`;
      hostImportsList = `[${meta.declaringModule.className}]`;
    } else if (!meta.standalone) {
      // Fallback: try importing the component directly or declaring it in an ad-hoc NgModule
      declaringModuleImport = `import { NgModule } from '@angular/core';\nimport { CommonModule } from '@angular/common';\n@NgModule({ declarations: [${meta.className}], imports: [CommonModule], exports: [${meta.className}] })\nexport class IsolatedFallbackModule {}`;
      hostImportsList = `[IsolatedFallbackModule]`;
    }

    // Build interactive @Input() bindings (using Angular Signals so both Zoneless and Zone.js update live!)
    // and @Output() event listeners that postMessage back to the IDE Webview panel.
    const inputBindings: string[] = [];
    const outputBindings: string[] = [];
    const hostInputProps: string[] = [];
    const inputUpdateCases: string[] = [];
    const initialInputReportEntries: string[] = [];

    meta.inputs.forEach((inp, idx) => {
      // Names/aliases are interpolated into generated TS and Angular template code: only allow plain identifiers
      if (!isSafeIdentifier(inp.name) || (inp.alias !== undefined && !isSafeIdentifier(inp.alias))) {
        return;
      }
      const propVar = `mockInput_${idx}`;
      const boundName = inp.alias || inp.name;
      let defaultVal = `'Sample ${inp.name}'`;

      if (inp.defaultValueExpr && !inp.defaultValueExpr.includes('input(') && !inp.defaultValueExpr.includes('input.')) {
        // Keep primitive literals if simple (except empty array `[]`, which we populate with a helpful sample)
        const trimmed = inp.defaultValueExpr.trim();
        if (/^(true|false|-?\d+(\.\d+)?|'[^']*'|"[^"]*")$/.test(trimmed)) {
          defaultVal = trimmed;
        }
      }

      if (defaultVal === `'Sample ${inp.name}'`) {
        if (inp.type === 'number') defaultVal = '1';
        else if (inp.type === 'boolean') defaultVal = 'false';
        else if (inp.type === 'array') defaultVal = `createSampleArrayInput('${inp.name}')`;
        else if (inp.type === 'object') {
          defaultVal = `createSampleObjectInput('${inp.name}')`;
        } else if (inp.rawType && inp.rawType.includes('PokemonTypeEnum')) {
          defaultVal = `'electric'`;
        }
      }

      hostInputProps.push(`  ${propVar} = signal<any>(${defaultVal});`);
      inputBindings.push(`[${boundName}]="${propVar}()"`);
      inputUpdateCases.push(
        `        if (msg.name === '${inp.name}' || msg.name === '${boundName}') {\n          this.${propVar}.set(msg.value);\n        }`
      );
      initialInputReportEntries.push(
        `      '${inp.name}': this.serializeSafe(this.${propVar}()),`
      );
    });

    meta.outputs.forEach((out) => {
      if (!isSafeIdentifier(out.name) || (out.alias !== undefined && !isSafeIdentifier(out.alias))) {
        return;
      }
      const boundOutName = out.alias || out.name;
      outputBindings.push(`(${boundOutName})="onComponentOutput('${out.name}', '${boundOutName}', $event)"`);
    });

    const allBindings = [...inputBindings, ...outputBindings];
    const bindingsStr = allBindings.length > 0 ? ' ' + allBindings.join(' ') : '';

    // Check if zone.js, @angular/router or @angular/common/http exist in project's node_modules
    const hasZoneJs = fs.existsSync(path.join(projectRoot, 'node_modules', 'zone.js'));
    const hasRouter = fs.existsSync(path.join(projectRoot, 'node_modules', '@angular', 'router'));
    const hasHttp = fs.existsSync(path.join(projectRoot, 'node_modules', '@angular', 'common', 'http'));
    const hasAnimations = fs.existsSync(path.join(projectRoot, 'node_modules', '@angular', 'platform-browser', 'animations'));

    const zoneImport = hasZoneJs ? `import 'zone.js';` : `// Zoneless Angular project detected`;
    const extraImports: string[] = [];
    const extraProviders: string[] = [];

    if (!hasZoneJs) {
      // Angular 19/20+ Zoneless change detection support
      extraImports.push(`import * as ngCore from '@angular/core';`);
      extraProviders.push(
        `    ...((ngCore as any).provideZonelessChangeDetection ? [(ngCore as any).provideZonelessChangeDetection()] : (ngCore as any).provideExperimentalZonelessChangeDetection ? [(ngCore as any).provideExperimentalZonelessChangeDetection()] : []),`
      );
    }

    if (hasRouter) {
      extraImports.push(`import { ActivatedRoute, Router, provideRouter } from '@angular/router';`);
      extraProviders.push(`    provideRouter([{ path: '**', children: [] }]),`);
      extraProviders.push(`    { provide: ActivatedRoute, useValue: createActivatedRouteMock() },`);
    }
    if (hasHttp) {
      extraImports.push(`import { provideHttpClient } from '@angular/common/http';`);
      extraProviders.push(`    provideHttpClient(),`);
    }
    if (hasAnimations) {
      extraImports.push(`import { provideNoopAnimations } from '@angular/platform-browser/animations';`);
      extraProviders.push(`    provideNoopAnimations(),`);
    }

    return `// Auto-generated by Angular Component Preview Extension
${zoneImport}
import '@angular/compiler';
${styleImports}
import { Component, ErrorHandler, Injectable, Injector, OnInit, signal, CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
${extraImports.join('\n')}
import { createSmartServiceInstance, createUniversalServiceMock, createActivatedRouteMock, createSampleObjectInput, createSampleArrayInput } from './auto-mock';
import { ${meta.className} } from ${JSON.stringify(componentImportPath)};
${declaringModuleImport}
${depImports.join('\n')}

@Injectable()
class PreviewErrorHandler implements ErrorHandler {
  handleError(error: any): void {
    console.error('[Angular Component Preview Error]', error);
    const banner = document.getElementById('ng-live-error-banner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = 'Runtime Notice (Handled): ' + (error?.message || String(error));
    }
  }
}

@Component({
  selector: 'ng-live-preview-host',
  standalone: true,
  imports: ${hostImportsList},
  schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
  template: \`
    <div class="ng-live-canvas">
      <${meta.selector}${bindingsStr}></${meta.selector}>
    </div>
  \`,
})
export class PreviewHostComponent implements OnInit {
${hostInputProps.join('\n')}

  ngOnInit(): void {
    window.addEventListener('message', (event) => {
      // Only accept control messages from the IDE webview that embeds this preview
      if (event.source !== window.parent || window.parent === window) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'NG_LIVE_SET_INPUT') {
${inputUpdateCases.join('\n')}
      } else if (msg.type === 'NG_LIVE_GET_INITIAL_INPUTS') {
        this.reportInitialInputs();
      }
    });
    this.reportInitialInputs();
  }

  reportInitialInputs(): void {
    const initialValues: Record<string, any> = {
${initialInputReportEntries.join('\n')}
    };
    window.parent?.postMessage({
      type: 'NG_LIVE_INITIAL_INPUTS',
      values: initialValues,
    }, '*');
  }

  onComponentOutput(name: string, alias: string, payload: any): void {
    window.parent?.postMessage({
      type: 'NG_LIVE_OUTPUT_EMITTED',
      name,
      alias,
      payload: this.serializeSafe(payload),
      timestamp: new Date().toLocaleTimeString(),
    }, '*');
  }

  private serializeSafe(val: any): any {
    try {
      if (val === undefined) return 'undefined';
      return JSON.parse(JSON.stringify(val));
    } catch {
      return String(val);
    }
  }
}

bootstrapApplication(PreviewHostComponent, {
  providers: [
    { provide: ErrorHandler, useClass: PreviewErrorHandler },
${extraProviders.join('\n')}
${depProviders.join('\n')}
  ],
}).catch((err) => {
  console.error('[Angular Component Preview Bootstrap Error]', err);
  const banner = document.getElementById('ng-live-error-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = 'Bootstrap Error: ' + (err?.message || String(err));
  }
});
`;
  }

  private buildIndexHtml(meta: ComponentMetadata, sessionToken: string): string {
    const cacheBust = Date.now();
    const safePrefix = `/${encodeURIComponent(sessionToken)}/`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Live Preview: ${escapeHtml(meta.className)}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .ng-live-canvas {
      padding: 16px;
      box-sizing: border-box;
    }
    #ng-live-error-banner {
      display: none;
      position: fixed;
      bottom: 8px;
      left: 8px;
      right: 8px;
      background: rgba(220, 38, 38, 0.92);
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      z-index: 99999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      white-space: pre-wrap;
    }
  </style>
  <!-- Root-anchored session paths so Angular Router URL normalization never breaks asset loading -->
  <link rel="stylesheet" href="${safePrefix}bundle.css?v=${cacheBust}" onerror="this.remove()" />
</head>
<body>
  <ng-live-preview-host></ng-live-preview-host>
  <div id="ng-live-error-banner"></div>
  <script type="module" src="${safePrefix}main.preview.js?v=${cacheBust}"></script>
  <script>
    // Live Reload via Server-Sent Events (SSE)
    const evtSource = new EventSource('${safePrefix}__ng_live_sse');
    evtSource.onmessage = (event) => {
      if (event.data === 'reload') {
        window.location.reload();
      } else if (event.data.startsWith('error:')) {
        const banner = document.getElementById('ng-live-error-banner');
        if (banner) {
          banner.style.display = 'block';
          banner.textContent = JSON.parse(event.data.slice(6));
        }
      }
    };
  </script>
</body>
</html>
`;
  }
}
