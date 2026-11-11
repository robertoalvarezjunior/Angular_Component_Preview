# Changelog

All notable changes to the **Angular Component Live** extension will be documented in this file.

## [0.1.0] - 2026-11-11

### Added
- **Isolated Component Execution**: Render any Angular `.component.ts` file inside an IDE side tab without building the entire project (`ng serve`) or adding the component to routes/templates.
- **Smart Dependency Injection & Universal Auto-Mocking**:
  - Automatically instantiates real project services inside Angular's `Injector` context (supporting real Signals, `computed()`, RxJS streams, and `HttpClient`).
  - Wraps services with a fault-tolerant recursive `Proxy` fallback compatible with Angular Signals, RxJS `Observable` (`.pipe()`, `.subscribe()`), `Promise` (`.then()`), `Set`, and `Array` iterators.
  - Built-in mocks for `ActivatedRoute`, `Router`, and `HttpClient`.
- **Interactive `@Input()` & `@Output()` DevTools Panel**:
  - Live editing for `@Input()` and `input()` / `input.required()` properties (boolean switches, number inputs, string inputs, and live JSON editor for complex objects/arrays).
  - Real-time event log for `@Output()` and `output()` emissions with timestamp and JSON payload inspection.
- **Zoneless & Zone.js Support**: Automatically detects whether the project uses `zone.js` or Angular v19/v20+ Zoneless change detection (`provideZonelessChangeDetection()`).
- **IDE UI Triggers**: CodeLens (`▶ Angular Component Live`) above `@Component`, editor title bar action button, and Explorer/Editor context menus.
- **Responsive Viewport & Theme Switcher**: Switch between `100%`, `Tablet (768px)`, and `Mobile (375px)` viewports and `Light`, `Dark`, or `Grid` canvas backgrounds.
