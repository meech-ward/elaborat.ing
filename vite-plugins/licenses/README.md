# License texts for packages that ship without one

Some npm packages state their license (in `package.json`, a README or their
repository) but include no license file, so the build has no text to put in
the notices. The notices plugin uses these copies instead, one file per
package, named after the package (`@scope/name` becomes `@scope__name.txt`).
A file named after a scope alone (`@scope.txt`) covers every package in that
scope, for scopes published from one repository under one license.

- `format.txt`: format 0.2.2, MIT, copyright line from its README
  (https://github.com/samsonjs/format).
- `react-remove-scroll-bar.txt`: react-remove-scroll-bar 2.3.8, MIT, from
  https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE.
- `@excalidraw__excalidraw.txt`: @excalidraw/excalidraw 0.18.1, MIT, from
  https://github.com/excalidraw/excalidraw/blob/master/LICENSE.
- `@radix-ui.txt`: every @radix-ui package Excalidraw bundles, MIT, from
  https://github.com/radix-ui/primitives/blob/main/LICENSE.
- `fastdom.txt`: fastdom 1.0.12, MIT, from the License section of its README
  (https://github.com/wilsonpage/fastdom).
- `victory-vendor.txt`: victory-vendor 37.3.6, MIT, from
  https://github.com/FormidableLabs/victory/blob/main/LICENSE.txt. Its ES
  build re-exports the d3 packages, which ship their own license files.
- `@terrastruct__d2.txt`: @terrastruct/d2 0.1.33, MPL-2.0, from
  https://github.com/terrastruct/d2/blob/master/LICENSE.txt. The ELK layout
  engine its browser build embeds is noted in `src/features/structured/compiler.ts`.
