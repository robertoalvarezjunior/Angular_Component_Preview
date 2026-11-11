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

**Angular Component Live** lets you run and preview any Angular component **100% in isolation** inside a side tab of your IDE—**without building the entire project (`ng serve`)** and **without adding the component to routes or parent templates**.

> 🇧🇷 *Guia completo em Português disponível na segunda metade deste documento ([clique aqui](#-guia-em-português)).*

---

## 📥 Installation

Search directly in your IDE Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`):
```text
Angular Component Live
```
Click **Install** and you're ready to go!

---

## ✨ Features

1. **Zero Full-Project Build (Instant Isolation)**
   - Compiles *only* the direct import graph of the selected component using `esbuild` and an ephemeral sandbox in `node_modules/.cache/angular-component-live` (never pollutes your `git status`).
2. **Interactive `@Input()` & `@Output()` DevTools Panel**
   - **Live `@Input()` Controls**: Automatically detects `@Input()`, `@Input({ required: true })`, and Signal `input()` / `input.required()`. Edit booleans, numbers, strings, and complex JSON objects/arrays in real time without touching your code.
   - **Real-Time `@Output()` Event Logger**: Listens to all `@Output()` `EventEmitter` and `output()` emissions, displaying timestamps and JSON payloads as you click and interact with the component.
3. **Smart Dependency Injection & Universal Auto-Mocking**
   - Detects services injected via `constructor(...)` or `inject(...)`.
   - Instantiates real services inside Angular's `Injector` context (so real **Signals**, `computed()`, `HttpClient`, and business logic work out-of-the-box) wrapped in a fault-tolerant **Universal Proxy Fallback** compatible with RxJS `Observable` (`.pipe()`, `.subscribe()`), `Promise`, `Signal`, `Set`, and `Array` iterables.
   - Pre-configured mocks for `ActivatedRoute`, `Router`, `HttpClient`, and animations.
4. **Multi-File Trigger Support**
   - Open the live preview directly from any component file: `.component.ts`, `.component.html`, `.component.scss`, `.css`, `.sass`, or `.less`.
5. **Zoneless & `zone.js` Compatible**
   - Automatically detects whether your project uses `zone.js` or Angular v19/v20+ Zoneless (`provideZonelessChangeDetection()`).
6. **Global Styles & Responsive Viewports**
   - Automatically loads global styles (`styles.scss` / `styles.css`) from `angular.json`.
   - Switch between **100%**, **Tablet (768px)**, and **Mobile (375px)** viewports, and **Light**, **Dark**, or **Transparency Grid** backgrounds.

---

## 🚀 How to Use

1. Open any Angular project in **Antigravity IDE**, **VS Code**, **Cursor**, or **Windsurf**.
2. Open any component file (`.ts`, `.html`, `.scss`, or `.css`).
3. Start the isolated preview using any of the triggers:
   - Click the colorful **Angular Live Preview** icon in the top-right Editor Title bar.
   - Click the **`▶ Angular Component Live (ComponentName)`** CodeLens button right above `@Component({...})` in the TypeScript file.
   - Right-click the file in the Explorer or Editor and select **`Angular Component Live: Open Isolated Preview`**.
4. Edit your component template, styles, or code and save (`Ctrl+S` / `Cmd+S`) to see instant Live Reload updates, or tweak `@Input()` values live in the bottom DevTools dock!

---

## ⚙️ Extension Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `angularComponentLive.enableCodeLens` | `boolean` | `true` | Show the `▶ Angular Component Live` button above `@Component` decorators. |
| `angularComponentLive.autoMockServices` | `boolean` | `true` | Automatically instantiate services with a recursive Proxy fallback for injected dependencies. |
| `angularComponentLive.port` | `number` | `0` | Port for the isolated preview server (`0` = automatically pick a free port). |

---

# 🇧🇷 Guia em Português

O **Angular Component Live** permite rodar e visualizar qualquer componente do Angular **de forma 100% isolada** em uma aba lateral da sua IDE (**Antigravity IDE**, **VS Code**, **Cursor**, **Windsurf**, etc.) — **sem precisar rodar `ng serve` do projeto inteiro** e **sem precisar referenciar o componente em rotas ou páginas**.

## 📥 Como Instalar

Instale diretamente pela aba de Extensões da sua IDE (`Ctrl+Shift+X`):
1. Pesquise por:
   ```text
   Angular Component Live
   ```
2. Clique em **Instalar**.

*(Ou instale offline via `.vsix`: no menu `...` da aba de extensões → **Install from VSIX...**).*

---

## ✨ Principais Recursos

- **Execução Isolada Instantânea (Zero Full-Build)**: Compila apenas a árvore de imports do componente selecionado dentro de `node_modules/.cache/angular-component-live` (sem sujar o seu `git status`).
- **Gatilho em Múltiplos Arquivos**: Abra o preview diretamente estando em arquivos `.component.ts`, `.component.html`, `.component.scss`, `.css`, `.sass` ou `.less`.
- **Painel Interativo de `@Input()` e `@Output()`**:
  - **Controles de `@Input()` ao vivo**: Altere textos, números, checkboxes booleanos e objetos/arrays JSON em tempo real (suporta `@Input()` tradicional e Signals `input()` / `input.required()`).
  - **Console de Eventos `@Output()`**: Visualize cada evento emitido pelo componente ao clicar nele, com horário e payload JSON.
- **Injeção de Dependência Inteligente & Auto-Mock**:
  - Detecta serviços no `constructor()` e `inject()`.
  - Instancia os serviços reais no contexto do Angular (mantendo **Signals**, `computed()` e `HttpClient` funcionando) com um **Proxy Fallback Universal** à prova de falhas para `Observable`, `Promise`, `Signal`, `Router` e `ActivatedRoute`.
- **Suporte a Angular Zoneless e `zone.js`**: Detecta automaticamente projetos Angular v15 até v20+ (Standalone, NgModules, Signals, `@if`/`@for` e Zoneless).
- **Estilos Globais e Viewports Responsivos**: Carrega automaticamente os estilos de `angular.json` e permite alternar entre Desktop (100%), Tablet (768px), Mobile (375px) e temas de fundo (Claro, Escuro e Grid).

---

## 🚀 Como Usar

1. Abra qualquer projeto Angular na IDE.
2. Abra qualquer arquivo do componente (`.ts`, `.html`, `.scss`, `.css`, etc.).
3. Clique no **ícone do Angular Live Preview** no canto superior direito do editor (ou no botão **`▶ Angular Component Live`** acima da classe).
4. O componente abrirá na aba lateral imediatamente. Ao editar e salvar (`Ctrl+S`), as mudanças são refletidas em tempo real!

---

## 🛠️ Desenvolvimento Local

Caso queira contribuir ou rodar o projeto em modo de desenvolvimento:
```bash
npm install
npm run compile
```
Pressione **F5** na IDE para iniciar o ambiente de testes (`Extension Development Host`).

---

## 📄 License / Licença

Licensed under the [MIT License](LICENSE).
