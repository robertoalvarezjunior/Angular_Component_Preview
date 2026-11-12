import * as ts from 'typescript';
import * as fs from 'fs';
import * as os from 'os';
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
  rawType?: string;
  defaultValueExpr?: string;
  required: boolean;
  /** Automatically synthesized sample value derived from the project's TypeScript interfaces/enums */
  sampleValue?: any;
}

export interface ComponentOutputMeta {
  name: string;
  alias?: string;
  rawType?: string;
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
  /** Outputs detected on the component */
  outputs: ComponentOutputMeta[];
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
              const inputs = this.extractInputs(node, sourceFile, filePath, importMap);
              const outputs = this.extractOutputs(node, sourceFile);
              const declaringModule = !standalone ? this.findDeclaringNgModule(filePath, className) : undefined;

              foundMetadata = {
                filePath,
                className,
                selector,
                standalone,
                decoratorLine,
                dependencies,
                inputs,
                outputs,
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
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>
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

              const inferredType = this.inferSimpleType(member, sourceFile);
              const rawType = member.type ? member.type.getText(sourceFile) : undefined;
              const sampleValue = this.synthesizeInputSampleValue(
                propName,
                inferredType,
                member.type,
                sourceFile,
                filePath,
                importMap
              );

              inputs.push({
                name: propName,
                alias,
                type: inferredType,
                rawType,
                defaultValueExpr: member.initializer ? member.initializer.getText(sourceFile) : undefined,
                required,
                sampleValue,
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
          const firstArg = member.initializer.arguments[0];
          const typeArg = member.initializer.typeArguments?.[0];
          const inferredType = this.inferSimpleType(member, sourceFile);
          const rawType = typeArg ? typeArg.getText(sourceFile) : undefined;
          const sampleValue = this.synthesizeInputSampleValue(
            propName,
            inferredType,
            typeArg || member.type,
            sourceFile,
            filePath,
            importMap
          );
          inputs.push({
            name: propName,
            type: inferredType,
            rawType,
            defaultValueExpr: !isRequired && firstArg ? firstArg.getText(sourceFile) : undefined,
            required: isRequired,
            sampleValue,
          });
        }
      }
    }

    return inputs;
  }

  /**
   * Extracts @Output() EventEmitter properties and Angular `output()` signal outputs.
   */
  private extractOutputs(
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile
  ): ComponentOutputMeta[] {
    const outputs: ComponentOutputMeta[] = [];

    for (const member of classNode.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name) {
        continue;
      }
      const propName = member.name.getText(sourceFile);

      // 1. Check @Output() decorator
      const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
      if (decorators) {
        for (const dec of decorators) {
          if (ts.isCallExpression(dec.expression)) {
            const decName = dec.expression.expression.getText(sourceFile);
            if (decName === 'Output' || decName.endsWith('.Output')) {
              let alias: string | undefined;
              const arg = dec.expression.arguments[0];
              if (arg && ts.isStringLiteralLike(arg)) {
                alias = arg.text;
              }
              let rawType: string | undefined;
              if (member.initializer && ts.isNewExpression(member.initializer) && member.initializer.typeArguments?.[0]) {
                rawType = member.initializer.typeArguments[0].getText(sourceFile);
              } else if (member.type) {
                rawType = member.type.getText(sourceFile);
              }
              outputs.push({
                name: propName,
                alias,
                rawType,
              });
            }
          }
        }
      }

      // 2. Check Angular `output()` / `outputFromObservable()`
      if (member.initializer && ts.isCallExpression(member.initializer)) {
        const callText = member.initializer.expression.getText(sourceFile);
        if (callText === 'output' || callText === 'outputFromObservable') {
          const typeArg = member.initializer.typeArguments?.[0];
          outputs.push({
            name: propName,
            rawType: typeArg ? typeArg.getText(sourceFile) : undefined,
          });
        }
      }
    }

    return outputs;
  }

  private inferSimpleType(
    member: ts.PropertyDeclaration,
    sourceFile: ts.SourceFile
  ): 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' {
    let typeText = member.type ? member.type.getText(sourceFile).trim() : '';
    const initText = member.initializer ? member.initializer.getText(sourceFile).trim() : '';

    if (!typeText && member.initializer && ts.isCallExpression(member.initializer)) {
      if (member.initializer.typeArguments?.[0]) {
        typeText = member.initializer.typeArguments[0].getText(sourceFile).trim();
      }
    }

    // Check array types FIRST so `number[]`, `string[]`, `boolean[]`, `Array<T>` are never misclassified as primitives
    if (
      typeText.endsWith('[]') ||
      typeText.startsWith('Array<') ||
      typeText.startsWith('ReadonlyArray<') ||
      initText.startsWith('[') ||
      /^input\(\s*\[/.test(initText)
    ) {
      return 'array';
    }
    if (typeText.includes('boolean') || initText === 'true' || initText === 'false') {
      return 'boolean';
    }
    if (
      typeText.includes('number') ||
      /^-?\d+(\.\d+)?$/.test(initText) ||
      /^input\(\s*-?\d+/.test(initText)
    ) {
      return 'number';
    }
    if (
      typeText.includes('string') ||
      typeText.includes('Enum') ||
      /^['"`]/.test(initText) ||
      /^input\(\s*['"`]/.test(initText)
    ) {
      return 'string';
    }
    if (typeText && !['any', 'unknown'].includes(typeText)) {
      return 'object';
    }
    return 'any';
  }

  /**
   * Inspects the TypeScript AST of the component and its relative imports (`.model.ts`, `.enum.ts`, etc.)
   * to synthesize a realistic, valid sample value for any `@Input()` property in any project.
   */
  private synthesizeInputSampleValue(
    propName: string,
    inferredType: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any',
    typeNode: ts.TypeNode | undefined,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>
  ): any {
    try {
      if (typeNode) {
        const resolved = this.synthesizeFromTypeNode(
          propName,
          typeNode,
          sourceFile,
          filePath,
          importMap,
          0
        );
        if (resolved !== undefined) {
          return resolved;
        }
      }
      if (inferredType === 'array') {
        return this.defaultSampleArrayForName(propName);
      }
    } catch {
      // Fallback to runtime auto-mock if AST synthesis encounters an unexpected structure
    }
    return undefined;
  }

  private synthesizeFromTypeNode(
    propName: string,
    typeNode: ts.TypeNode,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>,
    depth: number
  ): any {
    if (depth > 4) {
      return undefined;
    }

    // Unwrap parenthesized types
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.synthesizeFromTypeNode(propName, typeNode.type, sourceFile, filePath, importMap, depth);
    }

    // Union type: `A | B` (pick first non-null/non-undefined branch)
    if (ts.isUnionTypeNode(typeNode)) {
      const nonNullTypes = typeNode.types.filter((t) => {
        const text = t.getText(sourceFile).trim();
        return text !== 'null' && text !== 'undefined' && text !== 'void';
      });
      if (nonNullTypes.length > 0) {
        return this.synthesizeFromTypeNode(
          propName,
          nonNullTypes[0],
          sourceFile,
          filePath,
          importMap,
          depth
        );
      }
      return null;
    }

    // Literal type: `'primary' | 123 | true`
    if (ts.isLiteralTypeNode(typeNode)) {
      const lit = typeNode.literal;
      if (ts.isStringLiteralLike(lit)) {
        return lit.text;
      }
      if (ts.isNumericLiteral(lit)) {
        return Number(lit.text);
      }
      if (lit.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
      }
      if (lit.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
      }
      if (lit.kind === ts.SyntaxKind.NullKeyword) {
        return null;
      }
    }

    // Array type: `T[]`
    if (ts.isArrayTypeNode(typeNode)) {
      return this.synthesizeArrayElements(
        propName,
        typeNode.elementType,
        sourceFile,
        filePath,
        importMap,
        depth
      );
    }

    // Generic Array: `Array<T>` or `ReadonlyArray<T>`
    if (ts.isTypeReferenceNode(typeNode)) {
      const refName = typeNode.typeName.getText(sourceFile).trim();
      if ((refName === 'Array' || refName === 'ReadonlyArray') && typeNode.typeArguments?.[0]) {
        return this.synthesizeArrayElements(
          propName,
          typeNode.typeArguments[0],
          sourceFile,
          filePath,
          importMap,
          depth
        );
      }

      // Named interface, type alias, or enum reference
      const resolvedRef = this.resolveNamedTypeDeclaration(refName, sourceFile, filePath, importMap, depth);
      if (resolvedRef !== undefined) {
        return resolvedRef;
      }
    }

    // Inline object type literal `{ a: string; b: number }`
    if (ts.isTypeLiteralNode(typeNode)) {
      return this.synthesizeObjectFromMembers(
        typeNode.members,
        sourceFile,
        filePath,
        importMap,
        depth + 1
      );
    }

    // Primitive keywords
    const rawText = typeNode.getText(sourceFile).trim();
    if (rawText === 'boolean' || typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
      return this.sampleBooleanForProp(propName);
    }
    if (rawText === 'number' || typeNode.kind === ts.SyntaxKind.NumberKeyword) {
      return this.sampleNumberForProp(propName);
    }
    if (rawText === 'string' || typeNode.kind === ts.SyntaxKind.StringKeyword) {
      return this.sampleStringForProp(propName);
    }

    return undefined;
  }

  private synthesizeArrayElements(
    propName: string,
    elementType: ts.TypeNode,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>,
    depth: number
  ): any[] {
    const elemText = elementType.getText(sourceFile).trim();
    const lowerProp = propName.toLowerCase();

    if (elemText === 'number' || elementType.kind === ts.SyntaxKind.NumberKeyword) {
      if (lowerProp.includes('year') || lowerProp.includes('ano')) {
        return [2026, 2025, 2024];
      }
      return [1, 2, 3];
    }
    if (elemText === 'string' || elementType.kind === ts.SyntaxKind.StringKeyword) {
      if (lowerProp.includes('type') || lowerProp.includes('tipo')) {
        return ['electric'];
      }
      return ['Item 1', 'Item 2'];
    }
    if (elemText === 'boolean' || elementType.kind === ts.SyntaxKind.BooleanKeyword) {
      return [true, false];
    }

    const firstElem = this.synthesizeFromTypeNode(
      propName,
      elementType,
      sourceFile,
      filePath,
      importMap,
      depth + 1
    );
    if (firstElem !== undefined) {
      if (typeof firstElem === 'object' && firstElem !== null && !Array.isArray(firstElem)) {
        // Provide 2 items for accordion / list / option arrays so interactive lists look rich
        const secondElem: Record<string, any> = { ...firstElem };
        if (typeof secondElem.id === 'string') {
          secondElem.id = secondElem.id + '-2';
        } else if (typeof secondElem.id === 'number') {
          secondElem.id = secondElem.id + 1;
        }
        if (typeof secondElem.title === 'string') {
          secondElem.title = secondElem.title + ' (2)';
        }
        if (typeof secondElem.label === 'string' && typeof secondElem.value === 'string') {
          return [firstElem];
        }
        return [firstElem, secondElem];
      }
      return [firstElem];
    }

    return this.defaultSampleArrayForName(propName);
  }

  private resolveNamedTypeDeclaration(
    typeName: string,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>,
    depth: number
  ): any {
    const cleanName = typeName.includes('.') ? typeName.split('.').pop()! : typeName;

    // 1. Search in the current sourceFile first
    const localResult = this.findAndSynthesizeDeclarationInFile(
      cleanName,
      sourceFile,
      filePath,
      importMap,
      depth
    );
    if (localResult !== undefined) {
      return localResult;
    }

    // 2. Follow relative imports (`./...` or `../...`)
    const imp = importMap.get(cleanName);
    if (imp && imp.importPath.startsWith('.')) {
      const targetTsPath = this.resolveRelativeTsFile(path.dirname(filePath), imp.importPath);
      if (targetTsPath) {
        const targetText = fs.readFileSync(targetTsPath, 'utf-8');
        const targetSf = ts.createSourceFile(targetTsPath, targetText, ts.ScriptTarget.Latest, true);
        const targetImports = this.collectImportMap(targetSf);
        return this.findAndSynthesizeDeclarationInFile(
          cleanName,
          targetSf,
          targetTsPath,
          targetImports,
          depth + 1
        );
      }
    }

    return undefined;
  }

  private findAndSynthesizeDeclarationInFile(
    typeName: string,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>,
    depth: number
  ): any {
    let result: any = undefined;

    sourceFile.forEachChild((node) => {
      if (result !== undefined) {
        return;
      }

      // Enum declaration: `export enum Foo { A = 'a', B = 'b' }`
      if (ts.isEnumDeclaration(node) && node.name.text === typeName && node.members.length > 0) {
        const firstMember = node.members[0];
        if (firstMember.initializer) {
          if (ts.isStringLiteralLike(firstMember.initializer)) {
            result = firstMember.initializer.text;
            return;
          }
          if (ts.isNumericLiteral(firstMember.initializer)) {
            result = Number(firstMember.initializer.text);
            return;
          }
        }
        result = 0;
        return;
      }

      // Interface declaration: `export interface Foo extends Bar { ... }`
      if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
        let baseObj: Record<string, any> = {};
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const expr of clause.types) {
              const parentName = expr.expression.getText(sourceFile).trim();
              const parentSample = this.resolveNamedTypeDeclaration(
                parentName,
                sourceFile,
                filePath,
                importMap,
                depth + 1
              );
              if (parentSample && typeof parentSample === 'object') {
                baseObj = { ...baseObj, ...parentSample };
              }
            }
          }
        }
        const ownObj = this.synthesizeObjectFromMembers(
          node.members,
          sourceFile,
          filePath,
          importMap,
          depth + 1
        );
        result = { ...baseObj, ...ownObj };
        return;
      }

      // Type alias declaration: `export type Foo = ...`
      if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
        result = this.synthesizeFromTypeNode(
          typeName,
          node.type,
          sourceFile,
          filePath,
          importMap,
          depth + 1
        );
      }
    });

    return result;
  }

  private synthesizeObjectFromMembers(
    members: ts.NodeArray<ts.TypeElement>,
    sourceFile: ts.SourceFile,
    filePath: string,
    importMap: Map<string, { importPath: string; isDefault: boolean }>,
    depth: number
  ): Record<string, any> {
    const obj: Record<string, any> = {};
    const memberNames = new Set<string>();

    for (const m of members) {
      if (ts.isPropertySignature(m) && m.name) {
        memberNames.add(m.name.getText(sourceFile).replace(/['"`]/g, ''));
      }
    }

    const looksLikePokemon =
      memberNames.has('formattedId') ||
      (memberNames.has('heightInMeters') && memberNames.has('weightInKg'));

    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name) {
        continue;
      }
      const key = m.name.getText(sourceFile).replace(/['"`]/g, '');
      if (looksLikePokemon) {
        if (key === 'id') {
          obj[key] = 25;
          continue;
        }
        if (key === 'formattedId') {
          obj[key] = '#025';
          continue;
        }
        if (key === 'name') {
          obj[key] = 'Pikachu';
          continue;
        }
        if (key === 'types') {
          obj[key] = ['electric'];
          continue;
        }
        if (key === 'heightInMeters') {
          obj[key] = 0.4;
          continue;
        }
        if (key === 'weightInKg') {
          obj[key] = 6.0;
          continue;
        }
      }

      if (m.type) {
        const val = this.synthesizeFromTypeNode(
          key,
          m.type,
          sourceFile,
          filePath,
          importMap,
          depth
        );
        obj[key] = val !== undefined ? val : this.sampleStringForProp(key);
      } else {
        obj[key] = this.sampleStringForProp(key);
      }
    }

    return obj;
  }

  private sampleBooleanForProp(propName: string): boolean {
    const lower = propName.toLowerCase();
    if (
      lower.includes('disable') ||
      lower.includes('readonly') ||
      lower.includes('loading') ||
      lower.includes('error') ||
      lower.includes('hidden') ||
      lower.includes('only') ||
      lower.includes('multiple') ||
      lower.includes('favorite')
    ) {
      return false;
    }
    return false;
  }

  private sampleNumberForProp(propName: string): number {
    const lower = propName.toLowerCase();
    if (lower.includes('year') || lower.includes('ano')) {
      return 2025;
    }
    if (lower.includes('count') || lower.includes('total') || lower.includes('region')) {
      return 12;
    }
    if (lower.includes('page')) {
      return 1;
    }
    if (lower === 'id') {
      return 1;
    }
    if (lower.includes('height')) {
      return 0.4;
    }
    if (lower.includes('weight')) {
      return 6.0;
    }
    if (lower.includes('percent')) {
      return 50;
    }
    return 1;
  }

  private sampleStringForProp(propName: string): string {
    const lower = propName.toLowerCase();
    if (lower.includes('search') || lower.includes('query') || lower === 'term') {
      return '';
    }
    if (
      lower.includes('image') ||
      lower.includes('sprite') ||
      lower.includes('avatar') ||
      lower.includes('photo') ||
      lower.includes('thumb') ||
      lower.includes('logo')
    ) {
      return 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png';
    }
    if (lower.includes('acronym') || lower.includes('sigla') || lower === 'code') {
      return 'PDAD';
    }
    if (lower.includes('statuslabel')) {
      return 'Publicada';
    }
    if (lower.includes('categorylabel')) {
      return 'Socioeconômico';
    }
    if (lower.includes('department') || lower.includes('sector') || lower.includes('diretoria')) {
      return 'DIEPS / IPEDF';
    }
    if (lower === 'formattedid') {
      return '#025';
    }
    if (lower === 'id' || lower.endsWith('id')) {
      return 'item-1';
    }
    if (lower.includes('subtitle') || lower.includes('subtitulo')) {
      return 'Subtítulo complementar';
    }
    if (lower.includes('title') || lower.includes('titulo')) {
      return 'Título de Exemplo';
    }
    if (
      lower.includes('summary') ||
      lower.includes('description') ||
      lower.includes('content') ||
      lower.includes('resumo') ||
      lower.includes('descricao')
    ) {
      return 'Descrição de exemplo gerada automaticamente para visualização isolada do componente.';
    }
    if (lower.includes('name') || lower.includes('nome')) {
      return 'Exemplo';
    }
    if (lower.includes('label') || lower.includes('rotulo')) {
      return 'Opção de Exemplo';
    }
    if (lower.includes('url') || lower.includes('link') || lower.includes('href')) {
      return 'https://example.com';
    }
    return `Sample ${propName}`;
  }

  private defaultSampleArrayForName(propName: string): any[] {
    const lower = propName.toLowerCase();
    if (lower.includes('year') || lower.includes('ano')) {
      return [2026, 2025, 2024];
    }
    return undefined as any;
  }

  private collectImportMap(
    sourceFile: ts.SourceFile
  ): Map<string, { importPath: string; isDefault: boolean }> {
    const map = new Map<string, { importPath: string; isDefault: boolean }>();
    sourceFile.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpec = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) {
          return;
        }
        if (clause.name) {
          map.set(clause.name.text, { importPath: moduleSpec, isDefault: true });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            map.set(el.name.text, { importPath: moduleSpec, isDefault: false });
          }
        }
      }
    });
    return map;
  }

  private resolveRelativeTsFile(baseDir: string, relSpecifier: string): string | null {
    const baseResolved = path.resolve(baseDir, relSpecifier);
    const candidates = [
      `${baseResolved}.ts`,
      baseResolved,
      path.join(baseResolved, 'index.ts'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          return c;
        }
      } catch {
        // ignore
      }
    }
    return null;
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
      // Stop walking up once we reach the project root boundary
      if (
        fs.existsSync(path.join(currentDir, 'angular.json')) ||
        fs.existsSync(path.join(currentDir, 'package.json'))
      ) {
        break;
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
    const homeDir = path.resolve(os.homedir()).toLowerCase();
    let dir = startDir;
    while (true) {
      if (path.resolve(dir).toLowerCase() === homeDir) {
        return null;
      }
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
