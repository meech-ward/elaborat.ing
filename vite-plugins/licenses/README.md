# License texts for packages that ship without one

Some npm packages state their license (in `package.json`, a README or their
repository) but include no license file, so the build has no text to put in
the notices. The notices plugin uses these copies instead, one file per
package, named after the package (`@scope/name` becomes `@scope__name.txt`).

- `format.txt`: format 0.2.2, MIT, copyright line from its README
  (https://github.com/samsonjs/format).
- `react-remove-scroll-bar.txt`: react-remove-scroll-bar 2.3.8, MIT, from
  https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE.
