<p align="center">
  <img src="assets/icon.png" alt="Angular Component Live Logo" width="110" />
</p>

<h1 align="center">Angular Component Live</h1>

<p align="center">
  <strong>Isolated Live Preview & Interactive Playground for Angular Components inside Antigravity IDE, VS Code, Cursor & Windsurf.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Angular-v15%20--%20v20%2B-dd0031.svg" alt="Angular v15 - v20+" />
  <img src="https://img.shields.io/badge/Zoneless%20%26%20Signals-Supported-10b981.svg" alt="Signals & Zoneless Supported" />
</p>

---

**Angular Component Live** lets you run and preview any `.component.ts` file **100% in isolation** inside a side tab of your IDE—**without building the entire project (`ng serve`)** and **without adding the component to routes or parent templates**.

> 🇧🇷 *Guia completo em Português disponível na segunda metade deste documento ([clique aqui](#-guia-em-português)).*

---

## ✨ Features

1. **Zero Full-Project Build (Instant Isolation)**
   - Compiles *only* the direct import graph of the selected `.component.ts` file using `esbuild` and an ephemeral sandbox in `node_modules/.cache/angular-component-live` (never pollutes your `git status`).
2. **Interactive `@Input()` & `@Output()` DevTools Panel**
   - **Live `@Input()` Controls**: Automatically detects `@Input()`, `@Input({ required: true })`, and Signal `input()` / `input.required()`. Edit booleans, numbers, strings, and complex JSON objects/arrays in real time without touching your code.
   - **Real-Time `@Output()` Event Logger**: Listens to all `@Output()` `EventEmitter` and `output()` emissions, displaying timestamps and JSON payloads as you click and interact with the component.
3. **Smart Dependency Injection & Universal Auto-Mocking**
   - Detects services injected via `constructor(...)` or `inject(...)`.
   - Instantiates real services inside Angular's `Injector` context (so real **Signals**, `computed()`, `HttpClient`, and business logic work out-of-the-box) wrapped in a fault-tolerant **Universal Proxy Fallback** compatible with RxJS `Observable` (`.pipe()`, `.subscribe()`), `Promise`, `Signal`, `Set`, and `Array` iterables.
   - Pre-configured mocks for `ActivatedRoute`, `Router`, `HttpClient`, and animations.
4. **Zoneless & `zone.js` Compatible**
   - Automatically detects whether your project uses `zone.js` or Angular v19/v20+ Zoneless (`provideZonelessChangeDetection()`).
5. **Global Styles & Responsive Viewports**
   - Automatically loads global styles (`styles.scss` / `styles.css`) from `angular.json`.
   - Switch between **100%**, **Tablet (768px)**, and **Mobile (375px)** viewports, and **Light**, **Dark**, or **Transparency Grid** backgrounds.

---

## 🚀 How to Use

1. Open any Angular project in **Antigravity IDE** or **VS Code**.
2. Open any `*.component.ts` file.
3. Start the isolated preview using any of the 3 triggers:
   - Click the **`▶ Angular Component Live (ComponentName)`** CodeLens button right above `@Component({...})`.
   - Click the **Live Preview** icon in the top-right Editor Title bar.
   - Right-click the `.component.ts` file in the Explorer or Editor and select **`Angular Component Live: Open Isolated Preview`**.
4. Edit your `.component.ts`, `.component.html`, or `.component.scss` and save (`Ctrl+S` / `Cmd+S`) to see instant Live Reload updates, or tweak `@Input()` values live in the bottom DevTools dock!

---

## ⚙️ Extension Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `angularComponentLive.enableCodeLens` | `boolean` | `true` | Show the `▶ Angular Component Live` button above `@Component` decorators. |
| `angularComponentLive.autoMockServices` | `boolean` | `true` | Automatically instantiate services with a recursive Proxy fallback for injected dependencies. |
| `angularComponentLive.port` | `number` | `0` | Port for the isolated preview server (`0` = automatically pick a free port). |

---

# 🇧🇷 Guia em Português

O **Angular Component Live** permite rodar e visualizar qualquer arquivo `.component.ts` do Angular **de forma 100% isolada** em uma aba lateral da sua IDE (**Antigravity IDE**, **VS Code**, **Cursor**, etc.) — **sem precisar rodar `ng serve` do projeto inteiro** e **sem precisar referenciar o componente em rotas ou páginas**.

## ✨ Principais Recursos

- **Execução Isolada Instantânea (Zero Full-Build)**: Compila apenas a árvore de imports do componente selecionado dentro de `node_modules/.cache/angular-component-live` (sem sujar o seu `git status`).
- **Painel Interativo de `@Input()` e `@Output()`**:
  - **Controles de `@Input()` ao vivo**: Altere textos, números, checkboxes booleanos e objetos/arrays JSON em tempo real (suporta `@Input()` tradicional e Signals `input()` / `input.required()`).
  - **Console de Eventos `@Output()`**: Visualize cada evento emitido pelo componente ao clicar nele, com horário e payload JSON.
- **Injeção de Dependência Inteligente & Auto-Mock**:
  - Detecta serviços no `constructor()` e `inject()`.
  - Instancia os serviços reais no contexto do Angular (mantendo **Signals**, `computed()` e `HttpClient` funcionando) com um **Proxy Fallback Universal** à prova de falhas para `Observable`, `Promise`, `Signal`, `Router` e `ActivatedRoute`.
- **Suporte a Angular Zoneless e `zone.js`**: Detecta automaticamente projetos Angular v15 até v20+ (Standalone, NgModules, Signals, `@if`/`@for` e Zoneless).

## 🛠️ Como Instalar e Usar Localmente (Desenvolvimento ou `.vsix`)

### Opção 1: Instalar via arquivo `.vsix`
1. Gere o pacote instalável `.vsix`:
   ```bash
   npm install
   npm run vsix
   ```
2. Na **Antigravity IDE** ou **VS Code**, abra a aba de Extensões (`Ctrl+Shift+X`), clique no menu `...` (canto superior direito) → **Install from VSIX...** e selecione o arquivo `angular-component-live-0.1.0.vsix`.

### Opção 2: Rodar em modo Debug (`F5`)
1. Clone este repositório e instale as dependências:
   ```bash
   npm install
   npm run compile
   ```
2. Abra a pasta na IDE e pressione **F5** (`Run Extension (Angular Component Live)`).

---

## 📦 Como Publicar no Visual Studio Marketplace e Open VSX

O projeto já está configurado com `@vscode/vsce` (para o **Visual Studio Marketplace**) e `ovsx` (para o **Open VSX Registry**, usado pela Antigravity IDE, Cursor, VSCodium, etc.).

### Antes de Publicar
No arquivo [`package.json`](package.json), altere o campo `"publisher"` para o ID do seu publisher registrado:
```json
{
  "publisher": "seu-publisher-id"
}
```

### 1. Publicar no Visual Studio Marketplace (VS Code)
1. Crie uma conta e um Publisher em [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) usando um Personal Access Token (PAT) do Azure DevOps (com escopo `Marketplace -> Manage`).
2. Faça login e publique:
   ```bash
   npx @vscode/vsce login <seu-publisher-id>
   npm run publish:marketplace
   ```

### 2. Publicar no Open VSX Registry (Antigravity IDE / VSCodium / Cursor)
1. Crie uma conta em [open-vsx.org](https://open-vsx.org/), crie um namespace com o mesmo nome do seu `"publisher"` e gere um Access Token em *Settings -> Access Tokens*.
2. Publique com um único comando:
   ```bash
   npx ovsx publish -p <SEU_TOKEN_OPEN_VSX>
   ```
   *(Ou defina a variável de ambiente `OVSX_PAT` e execute `npm run publish:openvsx`).*

---

## 📄 License / Licença

Licensed under the [MIT License](LICENSE).
