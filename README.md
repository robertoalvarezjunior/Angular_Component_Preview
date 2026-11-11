# Angular Component Live (Antigravity IDE Extension)

Renderize qualquer arquivo `.component.ts` do Angular de forma **100% isolada** em uma aba ao vivo dentro da Antigravity IDE, sem precisar fazer o build do projeto inteiro (`ng serve`) e sem precisar adicionar o componente em rotas ou templates existentes.

## Principais Funcionalidades

- **Execução Isolada Instantânea**: Compila apenas o grafo de imports do componente selecionado usando `esbuild` + JIT/Template Inlining em um diretório de cache (`node_modules/.cache/angular-component-live`), sem sujar o `git status`.
- **Auto-Mock de Injeção de Dependências (DI)**:
  - Detecta serviços injetados via `constructor(...)` e `inject(...)` através de análise AST.
  - Cria automaticamente um **Universal Service Mock (Proxy recursivo)** compatível simultaneamente com **RxJS Observables** (`.pipe()`, `.subscribe()`), **Promises** (`.then()`), **Signals** e propriedades aninhadas, evitando que chamadas no `ngOnInit()` quebrem a visualização.
  - Inclui mocks prontos para `ActivatedRoute`, `Router`, `HttpClient` e animações.
- **Estilos Globais Preservados**: Lê o `angular.json` do projeto para importar automaticamente o `styles.scss` / `styles.css` global.
- **Gatilhos Rápidos na IDE**:
  - Botão **Live Preview** no topo do editor (`editor/title`) ao abrir qualquer `*.component.ts`.
  - Botão **CodeLens** `▶ Angular Component Live` acima do decorator `@Component`.
  - Opção no menu de contexto do arquivo.
- **Aba Visual Interativa**: Seletor de Viewport (`100%`, `Tablet 768px`, `Mobile 375px`), alternador de plano de fundo (`Light`, `Dark`, `Grid`) e Live Reload automático ao salvar `.ts`, `.html` ou `.scss`/`.css`.

## Como Compilar e Testar na Antigravity IDE

1. No terminal, na pasta raiz `c:/Projetos/Angular_Component_live`, instale as dependências e compile:
   ```bash
   npm install
   npm run compile
   ```
2. Pressione **F5** na Antigravity IDE (usando a configuração `Run Extension (Angular Component Live)` já criada em `.vscode/launch.json`) para abrir uma janela de desenvolvimento com a extensão ativa.
3. Abra qualquer projeto Angular e clique em **▶ Angular Component Live** acima de um `@Component` ou no ícone de Preview no topo direito do editor de qualquer arquivo `.component.ts`.
