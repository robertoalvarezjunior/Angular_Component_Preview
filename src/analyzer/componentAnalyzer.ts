import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

export interface InjectedDependency {
  /** Token name (e.g., 'UserService', 'ActivatedRoute') */
  tokenName: string;
  /** Import module specifier from the component file (e.g., './user.service', '@angular/router') */
  importPath?: string;
  /** Whether it's a named import or default import */
  isDefaultImport?: boolean;
}

export interface ComponentInputMeta {
  name: string;
  alias?: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  defaultValueExpr?: string;
  required: boolean;
}

export interface ComponentMetadata {
  filePath: string;
  className: string;
  selector: string;
  standalone: boolean;
  /** Line number (0-indexed) where @Component decorator starts */
  decoratorLine: number;
  /** Dependencies injected via constructor or inject() */
  dependencies: InjectedDependency[];
  /** Inputs detected on the component */
  inputs: ComponentInputMeta[];
  /** Nearest NgModule if standalone is false */
  declaringModule?: {
    className: string;
    filePath: string;
  };
}

/**
 * Built-in Angular tokens that should be handled by real/standard Angular providers
 * rather than generic Proxy replacement unless necessary.
 */
const BUILTIN_ANGULAR_TOKENS = new Set([
  'ElementRef',
  'ChangeDetectorRef',
  'Renderer2',
  'Injector',
  'EnvironmentInjector',
  'DestroyRef',
  'ViewContainerRef',
  'TemplateRef',
  'NgZone',
  'ApplicationRef',
  'DomSanitizer',
  'Title',
  'Meta',
  'HttpClient',
  'FormBuilder',
  'NonNullableFormBuilder',
]);

export class ComponentAnalyzer {
  /**
   * Parses an Angular `.component.ts` file and extracts metadata needed for isolated execution.
   */
  public analyzeFile(filePath: string): ComponentMetadata | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const sourceText = fs.readFileSync(filePath, 'utf-8');
    return this.analyzeSource(filePath, sourceText);
  }

  public analyzeSource(filePath: string, sourceText: string): ComponentMetadata | null {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true
    );

    // 1. Collect all imports in the file so we know where injected tokens come from
    const importMap = new Map<string, { importPath: string; isDefault: boolean }>();
    sourceFile.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpec = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) {
          return;
        }
        if (clause.name) {
          importMap.set(clause.name.text, { importPath: moduleSpec, isDefault: true });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            importMap.set(el.name.text, { importPath: moduleSpec, isDefault: false });
          }
        }
      }
    });

    let foundMetadata: ComponentMetadata | null = null;

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
        if (!decorators) {
          return;
        }

        for (const dec of decorators) {
          if (ts.isCallExpression(dec.expression)) {
            const exprText = dec.expression.expression.getText(sourceFile);
            if (exprText === 'Component' || exprText.endsWith('.Component')) {
              const className = node.name.text;
              const decoratorLine = sourceFile.getLineAndCharacterOfPosition(dec.getStart(sourceFile)).line;
              const configObj = dec.expression.arguments[0];

              let selector = 'ng-live-component';
              // In Angular 19+, standalone defaults to true when not specified; in older Angular, false unless standalone: true
              let standalone = this.detectDefaultStandalone(filePath);

              if (configObj && ts.isObjectLiteralExpression(configObj)) {
                for (const prop of configObj.properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                    const propName = prop.name.text;
                    if (propName === 'selector' && ts.isStringLiteralLike(prop.initializer)) {
                      selector = prop.initializer.text.split(',')[0].trim();
                    } else if (propName === 'standalone') {
                      standalone = prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
                    }
                  }
                }
              }

              const dependencies = this.extractDependencies(node, sourceFile, importMap);
              const inputs = this.extractInputs(node, sourceFile);
              const declaringModule = !standalone ? this.findDeclaringNgModule(filePath, className) : undefined;

              foundMetadata = {
                filePath,
                className,
                selector,
                standalone,
                decoratorLine,
                dependencies,
                inputs,
                declaringModule,
              };
            }
          }
        }
      }
      if (!foundMetadata) {
        ts.forEachChild(node, visit);
      }
    };

    visit(sourceFile);
    return foundMetadata;
  }

  /**
   * Extracts constructor parameter injections and property `inject(Token)` calls.
   */
  private extractDependencies(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    importMap: Map<string, { importPath: string; isDefault: boolean }>
  ): InjectedDependency[] {
    const deps = new Map<string, InjectedDependency>();

    const addToken = (tokenName: string) => {
      const cleanToken = tokenName.trim();
      if (!cleanToken || BUILTIN_ANGULAR_TOKENS.has(cleanToken)) {
        return;
      }
      // Ignore primitive types
      if (['string', 'number', 'boolean', 'any', 'unknown', 'Object', 'Function'].includes(cleanToken)) {
        return;
      }
      const imp = importMap.get(cleanToken);
      if (imp) {
        deps.set(cleanToken, {
          tokenName: cleanToken,
          importPath: imp.importPath,
          isDefaultImport: imp.isDefault,
        });
      } else {
        // Might be declared in the same file
        deps.set(cleanToken, {
          tokenName: cleanToken,
        });
      }
    };

    for (const member of classNode.members) {
      // 1. Check constructor parameters
      if (ts.isConstructorDeclaration(member)) {
        for (const param of member.parameters) {
          // Check for @Inject(TOKEN) decorator
          const decorators = ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined;
          let injectedTokenFromDecorator: string | null = null;
          if (decorators) {
            for (const dec of decorators) {
              if (ts.isCallExpression(dec.expression)) {
                const decName = dec.expression.expression.getText(sourceFile);
                if ((decName === 'Inject' || decName.endsWith('.Inject')) && dec.expression.arguments.length > 0) {
                  injectedTokenFromDecorator = dec.expression.arguments[0].getText(sourceFile);
                }
              }
            }
          }

          if (injectedTokenFromDecorator) {
            addToken(injectedTokenFromDecorator);
          } else if (param.type && ts.isTypeReferenceNode(param.type)) {
            const typeName = param.type.typeName.getText(sourceFile);
            addToken(typeName);
          }
        }
      }

      // 2. Check property initializers with `inject(Token)`
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        this.scanForInjectCalls(member.initializer, sourceFile, addToken);
      }
      // Also scan constructor body for `inject(Token)` calls
      if (ts.isConstructorDeclaration(member) && member.body) {
        this.scanForInjectCalls(member.body, sourceFile, addToken);
      }
    }

    return Array.from(deps.values());
  }

  private scanForInjectCalls(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    addToken: (token: string) => void
  ): void {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const exprText = n.expression.getText(sourceFile);
        if ((exprText === 'inject' || exprText.endsWith('.inject')) && n.arguments.length > 0) {
          const arg = n.arguments[0];
          if (ts.isIdentifier(arg)) {
            addToken(arg.text);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /**
   * Extracts @Input() properties and signal `input()` / `input.required()` properties
   * so we can provide safe default mock values if required inputs are missing.
   */
  private extractInputs(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile
  ): ComponentInputMeta[] {
    const inputs: ComponentInputMeta[] = [];

    for (const member of classNode.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name) {
        continue;
      }
      const propName = member.name.getText(sourceFile);

      // 1. Check @Input() decorator
      const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
      if (decorators) {
        for (const dec of decorators) {
          if (ts.isCallExpression(dec.expression)) {
            const decName = dec.expression.expression.getText(sourceFile);
            if (decName === 'Input' || decName.endsWith('.Input')) {
              let alias: string | undefined;
              let required = false;
              const arg = dec.expression.arguments[0];
              if (arg && ts.isStringLiteralLike(arg)) {
                alias = arg.text;
              } else if (arg && ts.isObjectLiteralExpression(arg)) {
                for (const p of arg.properties) {
                  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                    if (p.name.text === 'alias' && ts.isStringLiteralLike(p.initializer)) {
                      alias = p.initializer.text;
                    }
                    if (p.name.text === 'required' && p.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                      required = true;
                    }
                  }
                }
              }

              inputs.push({
                name: propName,
                alias,
                type: this.inferSimpleType(member, sourceFile),
                defaultValueExpr: member.initializer ? member.initializer.getText(sourceFile) : undefined,
                required,
              });
            }
          }
        }
      }

      // 2. Check Angular Signal `input()` or `input.required()`
      if (member.initializer && ts.isCallExpression(member.initializer)) {
        const callText = member.initializer.expression.getText(sourceFile);
        if (callText === 'input' || callText === 'input.required') {
          const isRequired = callText === 'input.required';
          inputs.push({
            name: propName,
            type: this.inferSimpleType(member, sourceFile),
            required: isRequired,
          });
        }
      }
    }

    return inputs;
  }

  private inferSimpleType(
    member: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile
  ): 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' {
    const typeText = member.type ? member.type.getText(sourceFile) : '';
    const initText = member.initializer ? member.initializer.getText(sourceFile) : '';

    if (typeText.includes('boolean') || initText === 'true' || initText === 'false') {
      return 'boolean';
    }
    if (typeText.includes('number')) {
      return 'number';
    }
    if (typeText.includes('string')) {
      return 'string';
    }
    if (typeText.endsWith('[]') || typeText.startsWith('Array<') || initText.startsWith('[')) {
      return 'array';
    }
    if (typeText && !['any', 'unknown'].includes(typeText)) {
      return 'object';
    }
    return 'any';
  }

  /**
   * Checks package.json to see if Angular is v19+ (where standalone is true by default).
   */
  private detectDefaultStandalone(componentFilePath: string): boolean {
    const pkgPath = this.findNearestPackageJson(path.dirname(componentFilePath));
    if (!pkgPath) {
      return false;
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const ngCoreVersion =
        pkg.dependencies?.['@angular/core'] || pkg.devDependencies?.['@angular/core'] || '';
      const majorMatch = ngCoreVersion.match(/(\d+)/);
      if (majorMatch && parseInt(majorMatch[1], 10) >= 19) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * Walks up directories to find a `.module.ts` file that declares `className`.
   */
  private findDeclaringNgModule(
    componentFilePath: string,
    className: string
  ): { className: string; filePath: string } | undefined {
    let currentDir = path.dirname(componentFilePath);
    for (let depth = 0; depth < 5; depth++) {
      if (!fs.existsSync(currentDir)) {
        break;
      }
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        if (entry.endsWith('.module.ts')) {
          const fullModPath = path.join(currentDir, entry);
          const content = fs.readFileSync(fullModPath, 'utf-8');
          if (content.includes(className)) {
            const match = content.match(/export\s+class\s+(\w+Module)/);
            if (match) {
              return {
                className: match[1],
                filePath: fullModPath,
              };
            }
          }
        }
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
    return undefined;
  }

  public findNearestPackageJson(startDir: string): string | null {
    let dir = startDir;
    while (true) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return null;
      }
      dir = parent;
    }
  }
}
