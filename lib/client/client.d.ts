/**
 * dsh-path-guard — Web client half.
 *
 * Why this file exists: DSH 0.1.7-rc.2 has NO generic auto-generated plugin
 * configuration page. The `settings` service does project a per-entry
 * `autoGenerate` flag (packages/settings/settings/src/index.ts:312,
 * packages/api/settings-controller/src/index.ts:51), but no client renderer
 * anywhere in the tree consumes it — every client-side occurrence of
 * `autoGenerate` lives in test fixtures. A plugin's configuration therefore
 * needs a client half of its own, exactly like the shipped companion packages
 * (`packages/client/ui-settings-agent-loop/src/client/index.ts`).
 *
 * This half registers the config page on the Plugins page (`plugins.row.config`
 * and `plugins.bundle.config`, see `apply` below) and binds it to the
 * `path-guard` settings namespace, which IS the row id in
 * `cordis.patch.yml` (packages/settings/settings/src/index.ts:315,382).
 *
 * Deliberate constraints:
 *   - compiled to `lib/client/client.js` by `tsc -p tsconfig.client.json` and
 *     loaded through `window.__ModuleLoader__.load` as a **classic script**
 *     (packages/client/modules/src/client/system.ts:15-29). `install_bundle`
 *     runs `pnpm add` only and never builds a package
 *     (packages/boot/plugin-manager/src/index.ts:461-559), so the built file has
 *     to sit in the repository. Keep this file free of `import`/`export`: the
 *     loader evaluates the output as a classic script, where ESM syntax does not
 *     parse.
 *   - only `react` is required, and it is a baseline external
 *     (packages/client/web/src/platform.ts:8-14) — no other Harness client
 *     package is imported, per the plugin authoring policy.
 *   - styling: every colour is a `--dsw-alias-*` theme token (so it follows the
 *     light/dark switch); geometry comes from the host's own variables where one
 *     exists (`--dsw-radius-*`, `--ds-font-family-code`, ui-theme/src/styles/base.css)
 *     and otherwise from the numbers the shipped pages use, each one cited at the
 *     property. No `font-family` is declared: this page inherits the host family
 *     (base.css:7-8). See the comment above `CONTROL`/`STYLE`.
 */
/**
 * The client-module loader the shell publishes on `window` before any bundle
 * runs. Declared locally instead of imported: a plugin may not depend on a DSH
 * client package, and `tsconfig.client.json` sets `"types": []` so nothing may
 * be borrowed from `@types/node` either.
 */
interface PathGuardModuleLoader {
    /**
     * Register one client half.
     * @param spec - the module id and the factory the module system later calls.
     */
    load(spec: {
        readonly id: string;
        readonly factory: (require: (id: string) => unknown) => unknown;
    }): void;
}
